// @vitest-environment happy-dom
// Нажатия кнопок — без звука: короткий ui.click («писк») убран по жалобе игроков
// (2026-10-17). Звучат только игровые события (повороты Решётки, награды, паки),
// поэтому общие кнопки/пилюли/переключатели playSound при клике не зовут.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const playSound = vi.fn();
vi.mock('@/shared/audio', () => ({ playSound: (...a: unknown[]) => playSound(...a) }));

import { CleanConfirmButton, SprayCapToggle, SprayNozzleButton } from './buttons';
import { Pill } from './primitives';

describe('кнопки не пищат при нажатии', () => {
  afterEach(() => { cleanup(); playSound.mockClear(); });

  it('SprayNozzleButton и CleanConfirmButton кликаются молча, но onClick работает', () => {
    const onClick = vi.fn();
    render(<><SprayNozzleButton onClick={onClick}>Buy</SprayNozzleButton><CleanConfirmButton onClick={onClick}>Confirm</CleanConfirmButton></>);
    fireEvent.click(screen.getByText('Buy'));
    fireEvent.click(screen.getByText('Confirm'));
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(playSound).not.toHaveBeenCalled();
  });

  it('кликабельная пилюля и переключатель тоже молчат', () => {
    const onClick = vi.fn();
    const onChange = vi.fn();
    render(<><Pill onClick={onClick}>Tab</Pill><SprayCapToggle on={false} onChange={onChange} label="Sound" /></>);
    fireEvent.click(screen.getByText('Tab'));
    fireEvent.click(screen.getByText('Sound'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(playSound).not.toHaveBeenCalled();
  });
});
