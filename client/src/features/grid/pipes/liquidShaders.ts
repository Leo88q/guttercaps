/**
 * GLSL for the liquid. Written for THREE.ShaderMaterial (three adds the attributes, matrices and
 * `cameraPosition`, and converts the GLSL 1.00 style to GLSL 3.00 es for WebGL2).
 *
 * LIQUID IN A TUBE
 *  The liquid is a TubeGeometry slightly thinner than the glass. For every pixel we know how far
 *  from the tube axis it is as seen by the camera:  r = sqrt(1 − (N·V)²)  (0 centre … 1 wall).
 *  That lateral position drives a real velocity profile:
 *    laminar   u(r) = 2(1 − r²)                (Poiseuille parabola, mean = 1)
 *    turbulent u(r) = 1.2245·(1 − r)^(1/7)     (1/7 power law, mean = 1)
 *  Streaks are advected with u(r)·v, so the centre outruns the wall (shear), and the pattern is
 *  re-seeded with a two-phase "flow map" so it never smears. The phase is accumulated on the CPU
 *  (uPhase += v·dt/uCycle), so changing/reversing the flow never makes the pattern jump.
 */

export const liquidVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vViewNormal;
varying vec3 vViewPos;
varying vec3 vObjNormal;

void main() {
  vUv = uv;
  vObjNormal = normal;
  vViewNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const liquidFragment = /* glsl */ `
uniform float uTime;
uniform float uPhase;     // accumulated advection, in cycles (signed)
uniform float uCycle;     // metres a streak travels per cycle
uniform float uFill;      // 0..1 priming front; >= 1 means the tube is full
uniform float uFillDir;   // +1 front travels from uv.x=0 to 1, -1 from 1 to 0
uniform float uTurb;      // 0 laminar .. 1 turbulent
uniform float uSpeed;     // |mean velocity|, m/s
uniform float uLength;    // tube length, m
uniform float uRadius;    // tube radius, m
uniform float uPressure;  // 0..1 normalised gauge pressure
uniform float uOpacity;
uniform vec3 uColorDeep;
uniform vec3 uColorLight;
uniform vec3 uColorGlow;

varying vec2 vUv;
varying vec3 vViewNormal;
varying vec3 vViewPos;
varying vec3 vObjNormal;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float profile(float r) {
  float lam = 2.0 * (1.0 - r * r);
  float tur = 1.2245 * pow(max(1.0 - r, 0.0001), 0.142857);
  return mix(lam, tur, uTurb);
}

// streak pattern anchored to the tube surface (object-space normal keeps it seamless around the tube)
vec2 pattern(float s, vec3 n) {
  vec3 q = vec3(n.x * 3.1 + n.z * 1.7, n.y * 3.3 + n.z * 0.9, 0.0);
  float lamin = vnoise(vec3(s * 9.0, q.x, q.y));
  float tur = 0.7 * vnoise(vec3(s * 20.0, q.x * 2.1 + uTime * 0.9, q.y * 2.1))
            + 0.3 * vnoise(vec3(s * 42.0, q.y * 3.9, q.x * 3.9 - uTime * 1.3));
  float body = mix(lamin, tur, uTurb);
  // sparse bright specks: entrained air, only visible in turbulent flow
  float bub = smoothstep(0.84, 0.9, vnoise(vec3(s * 38.0, q.x * 6.0, q.y * 6.0 + 7.0)));
  return vec2(body, bub);
}

void main() {
  vec3 N = normalize(vViewNormal);
  vec3 V = normalize(-vViewPos);
  float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
  float r = sqrt(max(1.0 - ndv * ndv, 0.0));

  // priming front with a curved meniscus
  float x = uFillDir > 0.0 ? vUv.x : 1.0 - vUv.x;
  float frontGlow = 0.0;
  if (uFill < 0.9999) {
    float rl = uRadius / max(uLength, 0.001);
    float edge = uFill + rl * (0.9 * (1.0 - r * r) - 0.3);
    if (x > edge) discard;
    float w = min(0.35, 3.0 * rl);
    frontGlow = 1.0 - clamp((edge - x) / w, 0.0, 1.0);
  }

  // advected streaks with the real velocity profile
  float s = vUv.x * uLength;
  float shear = mix(1.0, profile(r), 0.65);
  float p0 = fract(uPhase);
  float p1 = fract(uPhase + 0.5);
  float w01 = abs(2.0 * p0 - 1.0);
  vec2 a = pattern(s - p0 * uCycle * shear, vObjNormal);
  vec2 b = pattern(s - p1 * uCycle * shear, vObjNormal);
  vec2 pat = mix(a, b, w01);

  float moving = clamp(uSpeed / 1.2, 0.0, 1.0);

  // Beer–Lambert-ish: longer optical path through the middle of the tube → deeper colour
  vec3 col = mix(uColorLight, uColorDeep, smoothstep(0.0, 1.0, ndv * 0.95));
  col += (pat.x - 0.5) * (0.12 + 0.5 * moving) * (uColorLight + 0.15);
  col += pat.y * uTurb * moving * uColorGlow * 0.9;
  float fres = pow(1.0 - ndv, 3.0);
  col += fres * uColorGlow * 0.45;
  col = mix(col, uColorGlow, clamp(uPressure, 0.0, 1.0) * 0.10);
  col += frontGlow * frontGlow * uColorGlow * 0.8;

  float alpha = uOpacity * mix(0.58, 0.94, 1.0 - ndv);
  alpha = clamp(alpha + frontGlow * 0.2, 0.0, 1.0);
  gl_FragColor = vec4(max(col, vec3(0.0)), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Free surface of a tank: analytic ripples, fresnel against a sky gradient, one sun-like glint. */
export const surfaceVertex = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const surfaceFragment = /* glsl */ `
uniform float uTime;
uniform float uAmp;        // ripple strength, driven by inflow
uniform vec3 uCenter;      // world position of the tank axis at the surface
uniform vec3 uColorDeep;
uniform vec3 uColorLight;
uniform vec3 uSkyLow;
uniform vec3 uSkyHigh;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
varying vec3 vWorld;

void main() {
  vec2 p = vWorld.xz - uCenter.xz;
  float d = length(p);
  vec2 dir = d > 1e-4 ? p / d : vec2(0.0);
  float base = 0.012;
  vec2 k1 = vec2(7.0, 3.0);
  vec2 k2 = vec2(-4.0, 9.0);
  float c1 = cos(dot(k1, p) + uTime * 0.9);
  float c2 = cos(dot(k2, p) - uTime * 1.2);
  vec2 grad = base * (k1 * c1 + 0.6 * k2 * c2);
  float ring = cos(d * 26.0 - uTime * 4.0);
  grad += dir * ring * 26.0 * uAmp * exp(-d * 1.4) * 0.05;
  vec3 N = normalize(vec3(-grad.x, 1.0, -grad.y));
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 R = reflect(-V, N);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 sky = mix(uSkyLow, uSkyHigh, clamp(R.y * 0.5 + 0.5, 0.0, 1.0));
  float glint = pow(max(dot(R, normalize(uLightDir)), 0.0), 120.0);
  vec3 body = mix(uColorDeep, uColorLight, 0.35);
  vec3 col = mix(body, sky, fres) + glint * uLightColor;
  gl_FragColor = vec4(col, 0.9);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
