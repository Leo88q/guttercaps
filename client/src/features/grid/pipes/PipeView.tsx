import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { PipeScene } from './pipeScene';
import type { PipeTheme } from './pipeScene';
import type { PipeNetwork } from './pipeSolver';

export interface PipeViewProps {
  /** The simulated network. Create it once (useMemo / module scope); a new object rebuilds the scene. */
  network: PipeNetwork;
  /** Pass a stable object (module constant). Default: MARS_LAB_THEME. */
  theme?: PipeTheme;
  /** Simulated seconds per real second for tank levels (pipe flow is always drawn in real time). */
  timeScale?: number;
  paused?: boolean;
  /** Pipes that start empty and fill as liquid reaches them. */
  initiallyDry?: readonly string[];
  /** Called when the player taps a valve or pump. */
  onPickLink?: (id: string) => void;
  className?: string;
  style?: CSSProperties;
}

/** The parent must give this element a height (the canvas fills it). */
export function PipeView({ network, theme, timeScale = 1, paused = false, initiallyDry, onPickLink, className, style }: PipeViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<PipeScene | null>(null);
  const pickRef = useRef(onPickLink);
  const dryKey = initiallyDry ? initiallyDry.join(',') : '';

  useEffect(() => {
    pickRef.current = onPickLink;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new PipeScene(host, network, {
      theme,
      timeScale,
      initiallyDry: dryKey ? dryKey.split(',') : [],
      onPickLink: (id) => pickRef.current?.(id),
    });
    scene.paused = paused;
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
    // timeScale and paused are applied live by the effects below; rebuilding the scene for them would reset it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, theme, dryKey]);

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.timeScale = timeScale;
  }, [timeScale]);

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.paused = paused;
  }, [paused]);

  return <div ref={hostRef} className={className} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', ...style }} />;
}
