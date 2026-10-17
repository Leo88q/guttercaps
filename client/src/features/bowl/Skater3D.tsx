// Трёхмерный райдер Линии: настоящая скелетная анимация вместо статичного
// спрайта (жалоба 2026-10-18: «персонаж статичный»). Модель — Kenney
// «Mini Skate» (CC0, см. THIRD_PARTY_KENNEY.md рядом): в GLB лежат клипы
// skate / skate-air / skate-grab / die, они и выбираются по состоянию
// заезда детерминированного движка economy. Физика и очки не отсюда —
// отсюда только картинка.
//
// three.js грузится динамически и только на экране Линии/реплея: в
// критический бандл (bundle-check) он не попадает. Если WebGL или модель
// недоступны, честно остаётся 2D-спрайт райдера — игра не ломается.
import { useEffect, useRef, useState } from 'react';

export type SkaterClip = 'ride' | 'stand' | 'air' | 'grab' | 'grind' | 'down';

const CLIP_NAME: Record<SkaterClip, string> = {
  ride: 'skate',        // толкается и катит
  stand: 'skate-stand', // стоит на доске до старта
  air: 'skate-air',     // в прыжке
  grab: 'skate-grab',   // трюк в воздухе
  grind: 'skate',       // отдельного клипа гринда у модели нет — катит
  down: 'die',          // падение
};

const MODEL = (silhouette: number) => `/art/skate/character-skate-${silhouette % 2 === 0 ? 'boy' : 'girl'}.glb`;

export default function Skater3D({ clip, silhouette, fallback }: {
  clip: SkaterClip;
  silhouette: number;
  /** 2D-спрайт на время загрузки модели и на случай отказа WebGL. */
  fallback: string;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const clipRef = useRef<SkaterClip>(clip);
  clipRef.current = clip;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    let cleanup = () => {};
    (async () => {
      try {
        const THREE = await import('three');
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        if (dead || !hostRef.current) return;
        const host = hostRef.current;
        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer.setSize(host.clientWidth || 84, host.clientHeight || 150);
        host.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(32, (host.clientWidth || 84) / (host.clientHeight || 150), 0.1, 50);
        camera.position.set(0.4, 1.05, 3.4);
        camera.lookAt(0, 0.85, 0);
        scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1420, 1.15));
        const key = new THREE.DirectionalLight(0xffffff, 1.6);
        key.position.set(2, 4, 3);
        scene.add(key);
        const neon = new THREE.PointLight(0xff2e8a, 12, 12);
        neon.position.set(-2, 1.4, 1.6);
        scene.add(neon);
        const cyan = new THREE.PointLight(0x16e5d9, 9, 12);
        cyan.position.set(2.4, 0.7, 1.2);
        scene.add(cyan);

        const loader = new GLTFLoader();
        const group = new THREE.Group();
        // Модель смотрит в +Z; разворачиваем профилем по ходу трассы (+X экрана).
        group.rotation.y = Math.PI / 2;
        scene.add(group);

        const charGltf = await loader.loadAsync(MODEL(silhouette));
        if (dead) return;
        const char = charGltf.scene;
        // Нормируем рост к ~1.7 единицам, ноги — на ноль.
        const box = new THREE.Box3().setFromObject(char);
        const scale = 1.7 / Math.max(0.001, box.max.y - box.min.y);
        char.scale.setScalar(scale);
        char.position.y = -box.min.y * scale;
        group.add(char);

        const boardGltf = await loader.loadAsync('/art/skate/skateboard.glb');
        if (dead) return;
        const board = boardGltf.scene;
        const bbox = new THREE.Box3().setFromObject(board);
        const bScale = 0.95 / Math.max(0.001, bbox.max.x - bbox.min.x);
        board.scale.setScalar(bScale);
        board.position.y = 0.02;
        group.add(board);

        const mixer = new THREE.AnimationMixer(char);
        const actions = new Map<string, import('three').AnimationAction>();
        for (const anim of charGltf.animations) {
          const a = mixer.clipAction(anim);
          if (anim.name === 'die') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
          actions.set(anim.name, a);
        }
        let current: import('three').AnimationAction | null = null;
        const playClip = (want: SkaterClip) => {
          const a = actions.get(CLIP_NAME[want]) ?? actions.get('skate');
          if (!a || a === current) return;
          a.reset().fadeIn(0.15).play();
          current?.fadeOut(0.15);
          current = a;
        };
        playClip(clipRef.current);
        setReady(true);

        const clock = new THREE.Clock();
        let raf = 0;
        const loop = () => {
          raf = requestAnimationFrame(loop);
          playClip(clipRef.current);
          mixer.update(Math.min(0.05, clock.getDelta()));
          renderer.render(scene, camera);
        };
        loop();
        cleanup = () => {
          cancelAnimationFrame(raf);
          mixer.stopAllAction();
          renderer.dispose();
          renderer.domElement.remove();
        };
      } catch {
        if (!dead) setFailed(true);
      }
    })();
    return () => { dead = true; cleanup(); };
    // Модель зависит от силуэта (boy/girl); клип читается из ref каждый кадр.
  }, [silhouette]);

  if (failed) return <img src={fallback} alt="" aria-hidden />;
  return (
    <span ref={hostRef} className="skater3d" aria-hidden>
      {!ready && <img src={fallback} alt="" aria-hidden />}
    </span>
  );
}
