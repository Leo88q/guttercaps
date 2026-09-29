// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LOCALES, setLocale, useT, t } from '@/shared/i18n';
import { Modal } from './primitives';

function Nested() {
  const text = useT();
  const [outer, setOuter] = useState(false), [inner, setInner] = useState(false);
  const closeBoth = () => { setInner(false); setOuter(false); };
  return <><button onClick={() => setOuter(true)}>{text('common.seeAll')}</button>
    {outer && <Modal open title={text('collection.title')} onClose={() => setOuter(false)}>
      <button onClick={() => setInner(true)}>{text('market.list')}</button>
      {inner && <Modal open title={text('market.list')} onClose={closeBoth}>
        <button onClick={closeBoth}>{text('common.close')}</button>
      </Modal>}
    </Modal>}
  </>;
}
afterEach(async () => { cleanup(); document.body.style.overflow = ''; await act(() => setLocale('en')); });
for (const locale of LOCALES) it(`${locale}: nested modal titles update live, Escape closes only the top dialog and restores scrolling/focus`, async () => {
  await act(() => setLocale(locale));
  document.body.style.overflow = 'clip';
  render(<Nested />);
  const opener = screen.getByRole('button', { name: t('common.seeAll') });
  opener.focus(); fireEvent.click(opener);
  const listing = screen.getByRole('button', { name: t('market.list') });
  expect(document.activeElement).toBe(listing);
  fireEvent.click(listing);
  const top = screen.getAllByRole('dialog')[1];
  const close = within(top).getByRole('button', { name: t('common.close') });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(window, { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  await act(() => setLocale(locale === 'en' ? 'ru' : 'en'));
  expect(screen.getByRole('dialog', { name: t('market.list') })).toBe(top);
  expect(within(top).getByRole('button', { name: t('common.close') })).toBe(close);
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.style.overflow).toBe('clip');
  expect(document.activeElement).toBe(opener);
});

it('an outer dialog releasing its lock cannot unlock the page while another dialog is open', () => {
  document.body.style.overflow = 'scroll';
  const tree = (outer: boolean, inner: boolean) => <>
    <Modal open={outer} title="Outer" onClose={() => {}}><button>Outer action</button></Modal>
    <Modal open={inner} title="Inner" onClose={() => {}}><button>Inner action</button></Modal>
  </>;
  const view = render(tree(true, true));
  view.rerender(tree(false, true));
  expect(document.body.style.overflow).toBe('hidden');
  view.rerender(tree(false, false));
  expect(document.body.style.overflow).toBe('scroll');
});
