import { leagueText } from '@/shared/lib/rarity';
import { joinText, amountText } from '@/shared/i18n/message';
// Cap Slam arena: squad builder (power, elements, synergy), ranked queue,
// optional wager with on-chain escrow, season + rating overview.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { MATCH_REWARDS, MATCHMAKING, SEASON } from '@guttercaps/economy';
import { useArenaMe, useMyChips, useMyServices, useSeason, useQueueArena, useLeaveQueue, useRevealNonce, type Chip } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { sendArenaTx } from '@/chain/flows/arenaTx';
import { TxError } from '@/chain/tx';
import { prepareRandomness } from '@/chain/switchboard';
import { initRandomnessIx } from '@/chain/ix/rng';
import { recentLookupSlots } from '@/chain/lookupTableSlots';
import { createCompressedBattleV2Ix, acceptCompressedBattleV2Ix, wagerSplit, MIN_WAGER, MAX_WAGER, MIN_SQUAD_POWER, leagueOf, type CompressedArenaChipProof } from '@/chain/ix/arena';
import { resolveCompressedSquad } from '@/chain/flows/compressedChip';
import { dasClient } from '@/features/market/payment';
import { battlePda } from '@/chain/pdas';
import { BATTLE_STATUS, decodeWagerBattle, type WagerBattle } from '@/chain/accounts';
import { RNG_KIND, freshNonce } from '@/chain/pdas';
import { ChipArt } from '@/shared/ui/ChipArt';
import { CleanZone, KV, Modal, Pill, Stat, Skeleton } from '@/shared/ui/primitives';
import { SprayNozzleButton, CleanConfirmButton } from '@/shared/ui/buttons';
import { leagueName, chipPower, squadPower, squadSynergy, ELEMENT_OF_COLLECTION, rarityColor, rarityName, chipName, chipImageOf } from '@/shared/lib/rarity';
import { ElementGlyph } from '@/shared/ui/element-icons';
import { fmtCg, fmtDecimal, countdown, parseUnits, shortKey } from '@/shared/lib/format';
import { useUiStore } from '@/app/store/ui';
import { isMock } from '@/api/client';
import { EXPLORER, LOOKUP_TABLE } from '@/app/config';
import { useT } from '@/shared/i18n';
import { loadTheme, ownedThemes, themeById } from '@/shared/lib/cosmetics';

export default function Arena() {
  const t = useT();
  const { connected } = useWallet();
  const me = useArenaMe();
  const season = useSeason();
  const chips = useMyChips({});
  const cfg = useGameConfig();
  const wallet = useWalletLike();
  const { connection } = useConnection();
  const toast = useUiStore((s) => s.toast);
  const queue = useQueueArena();
  const services = useMyServices();
  // profile lamp themes also tint the arena intro (queue / current-match banner)
  const themesOwned = ownedThemes(services.data?.entitlements);
  const savedTheme = loadTheme(wallet?.publicKey?.toBase58());
  const lamp = themesOwned.length > 0 ? themeById(savedTheme && themesOwned.includes(savedTheme) ? savedTheme : themesOwned[0]).hex : null;
  const introStyle = lamp ? { borderColor: lamp, boxShadow: `0 0 14px ${lamp}44` } : undefined;
  const leave = useLeaveQueue();
  const revealNonce = useRevealNonce();
  const [squad, setSquad] = useState<Chip[]>([]);
  const [pick, setPick] = useState(false);
  const [wager, setWager] = useState<string | null>(null);
  const [queued, setQueued] = useState<{ ticket: string; wait: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastMatch, setLastMatch] = useState<{ id: string; won: boolean | null } | null>(null);
  const revealing = useRef<string | null>(null);

  // commit–reveal, second half: as soon as the server paired us, reveal the nonce we committed to.
  // The nonce lives in sessionStorage so a page reload between queue and pairing still resolves.
  const cm = me.data?.currentMatch;
  const current = cm?.id ? { id: cm.id, opponent: cm.opponent ?? '', iRevealed: !!cm.iRevealed, revealDeadline: cm.revealDeadline ?? new Date().toISOString() } : null;
  const currentId = current?.id, currentRevealed = current?.iRevealed, currentOpponent = current?.opponent ?? '';
  useEffect(() => {
    if (!currentId || currentRevealed || revealing.current === currentId) return;
    const nonce = sessionStorage.getItem('gc.arena.nonce');
    if (!nonce) return;
    revealing.current = currentId;
    setQueued(null);
    revealNonce.mutateAsync({ id: currentId, nonce })
      .then((r) => {
        if (r?.resolved) { const won = r.winner === wallet?.publicKey.toBase58(); setLastMatch({ id: currentId, won }); toast({ kind: won ? 'money' : 'info', title: won ? { key: 'arena.youWon' } : { key: 'arena.youLost' }, body: joinText([{ key: 'ui.vs' }, " ", currentOpponent.startsWith('bot:') ? { key: 'ui.bot' } : currentOpponent.slice(0, 6)]) }); }
        else toast({ kind: 'info', title: { key: 'ui.seedRevealed' }, body: { key: 'ui.waitingOpponent' } });
      })
      .catch((e) => { revealing.current = null; toast({ kind: 'error', title: { key: 'ui.revealFailed' }, error: e }); });
  }, [currentId, currentRevealed, currentOpponent, revealNonce, toast, wallet, t]);
  // the opponent revealed after us → the match resolved server-side; surface the result once
  useEffect(() => {
    const r = me.data?.recent?.[0];
    if (!r || !revealing.current || r.id !== revealing.current || lastMatch?.id === r.id) return;
    setLastMatch({ id: r.id, won: r.won ?? null });
    revealing.current = null;
  }, [me.data, lastMatch]);
  // server-side state wins over local memory (reload, second tab, ticket expiry)
  useEffect(() => { if (me.data && !me.data.queue && !me.data.currentMatch && queued) setQueued(null); }, [me.data, queued]);

  const all = useMemo(() => (chips.data?.pages.flatMap((p) => p.items ?? []) ?? []).filter((c) => !c.flags?.listed && !c.flags?.fusing), [chips.data]);
  const power = squadPower(squad.map((c) => ({ rarity: c.rarity!, level: c.level! })));
  const synergy = squadSynergy(squad.map((c) => ({ collection: c.collection! })));
  const league = leagueOf(power);
  const ready = squad.length === 3 && power >= MIN_SQUAD_POWER;
  const squadHint = squad.length !== 3 ? t('arena.acceptNeedSquad')
    : power < MIN_SQUAD_POWER ? t('arena.squadTooWeak', { power: fmtDecimal(power, 0), min: MIN_SQUAD_POWER }) : null;

  async function joinRanked() {
    if (!ready) return;
    setBusy(true);
    try {
      // commit-reveal for the server-authoritative match: commit = sha256(nonce)
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      const nonceHex = Array.from(nonce, (b) => b.toString(16).padStart(2, '0')).join('');
      const commit = Array.from(sha256(nonce), (b) => b.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem('gc.arena.nonce', nonceHex);
      const r = await queue.mutateAsync({ squad: squad.map((c) => c.asset!), commit });
      setLastMatch(null);
      revealing.current = null;
      setQueued({ ticket: r.ticket!, wait: r.estimatedWaitSec ?? 30 });
      toast({ kind: 'info', title: r.matchId ? { key: 'ui.opponentFound' } : { key: 'ui.inQueue' }, body: r.matchId ? { key: 'screens.opponentReveal' } : { key: 'screens.leagueWait', params: { league: leagueText(r.league ?? league), s: r.estimatedWaitSec ?? 30 } } });
    } catch (e) {
      toast({ kind: 'error', title: { key: 'ui.queueFailed' }, error: e });
    } finally { setBusy(false); }
  }

  /**
   * Resolve the three chosen caps into arena proofs. Identity (claim, tree, leaf index) comes from
   * the on-chain projection and the Merkle path from DAS, which is the only place that has it —
   * `create_battle_v2` / `accept_battle_v2` re-verify all three roots on chain.
   *
   * A missing member fails the squad rather than sending a short one: the builders already refuse
   * anything but three, but failing here gives the user a readable message instead of a revert.
   */
  const squadProofs = async (): Promise<CompressedArenaChipProof[]> => {
    if (squad.length !== 3) throw new Error('a wager battle needs exactly three caps');
    const resolved = await resolveCompressedSquad(connection, dasClient(), squad.map((c) => new PublicKey(c.asset!)), { owner: wallet?.publicKey });
    // `delegate` is the live leaf delegate, which is what the program checks the squad against
    return resolved.map((r) => ({ claim: r.claim, chip: r.chip, merkleTree: r.merkleTree, proof: r.leaf, delegate: r.delegate }));
  };

  async function createWager(amountMicro: bigint) {
    if (!ready) return;
    if (isMock()) { toast({ kind: 'money', title: { key: 'screens.wagerCreated' }, body: { key: 'screens.escrowed', params: { amount: amountText(amountMicro, 'CG') } } }); setWager(null); return; }
    if (!wallet || !cfg.data) return;
    setBusy(true);
    try {
      const nonce = freshNonce();
      // arena-owned randomness PDA ["rng", 2, challenger, nonce]: init here, commit inside create_battle_v2 (SEC-C3 part 2)
      const rnd = await prepareRandomness(connection, wallet.publicKey, RNG_KIND.BATTLE, nonce);
      // Every slot carries the registered projection and a fresh proof. Resolve from chain/DAS
      // again after table setup so slow wallet prompts don't consume the CMT changelog window.
      let minContextSlot: number | undefined;
      const { signature } = await sendArenaTx(connection, wallet, async () => {
        const proofs = await squadProofs();
        const ix = createCompressedBattleV2Ix({
          challenger: wallet.publicKey, nonce, wager: amountMicro, randomness: rnd.randomness,
          queue: rnd.queue, oracle: rnd.oracle, squad: proofs, delegates: proofs.map((x) => x.delegate), cgMint: cfg.data!.cgMint,
        });
        // LUT setup may involve several wallet prompts. Refresh Switchboard's recent-slot
        // argument too; init and the wager still commit atomically in the final packet.
        const recent = await recentLookupSlots(connection);
        minContextSlot = recent.contextSlot;
        return [initRandomnessIx({ ...rnd, recentSlot: BigInt(recent.slots[0]) }), ix];
      }, { lookupTable: LOOKUP_TABLE, minContextSlot: () => minContextSlot });
      toast({ kind: 'money', title: { key: 'screens.wagerOpen' }, body: { key: 'screens.escrowWaiting', params: { amount: amountText(amountMicro, 'CG') } }, href: EXPLORER.tx(signature) });
      // the invite IS the PDA seed, so the challenger can hand it over and the opponent lands straight
      // on the accept panel below
      setInvite({ challenger: wallet.publicKey.toBase58(), nonce: nonce.toString() });
      setBattle(null); setBattleErr(null);
      setWager(null);
    } catch (e) {
      toast({ kind: 'error', title: { key: 'screens.wagerFailed' }, error: e, href: e instanceof TxError && e.signature ? EXPLORER.tx(e.signature) : undefined });
    } finally { setBusy(false); }
  }

  // --- accept a wager battle ---------------------------------------------------------------
  // create_battle had no counterpart in the UI: `acceptBattleIx` existed in chain/ix/arena.ts but was
  // imported nowhere, so a challenger could escrow a stake and nobody could take it. The battle account
  // is the only discovery channel there is — the backend runs a separate, server-authoritative ranked
  // queue and knows nothing about on-chain wager battles — so an invite is (challenger, nonce), which is
  // exactly the PDA seed. It travels as a link, and the challenger sees it right after escrowing.
  const [params] = useSearchParams();
  const urlChallenger = params.get('challenger') ?? '';
  const urlNonce = params.get('nonce') ?? '';
  const [invite, setInvite] = useState<{ challenger: string; nonce: string } | null>(
    urlChallenger && urlNonce ? { challenger: urlChallenger, nonce: urlNonce } : null,
  );
  const [battle, setBattle] = useState<WagerBattle | null>(null);
  const [battleErr, setBattleErr] = useState<string | null>(null);
  // an invite that arrived in the URL is a link somebody clicked: load it straight away
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (autoLoaded.current || !invite) return;
    autoLoaded.current = true;
    void loadBattle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadBattle() {
    if (!invite) return;
    setBattleErr(null); setBattle(null);
    let challenger: PublicKey; let nonce: bigint;
    try { challenger = new PublicKey(invite.challenger.trim()); }
    catch { setBattleErr(t('arena.acceptBadAddress')); return; }
    if (!/^[0-9]+$/.test(invite.nonce.trim())) { setBattleErr(t('arena.acceptBadNonce')); return; }
    nonce = BigInt(invite.nonce.trim());
    try {
      const info = await connection.getAccountInfo(battlePda(challenger, nonce)[0], 'confirmed');
      if (!info) { setBattleErr(t('arena.acceptNotFound')); return; }
      const b = decodeWagerBattle(new Uint8Array(info.data));
      if (b.status !== 0) { setBattleErr(t('arena.acceptNotOpen', { status: BATTLE_STATUS[b.status] ?? b.status })); return; }
      if (wallet && b.challenger.equals(wallet.publicKey)) { setBattleErr(t('arena.acceptSelf')); return; }
      setBattle(b);
    } catch (e) {
      setBattleErr(t('arena.acceptNotFound'));
      if (!isMock()) console.warn('[arena] battle lookup failed', e);
    }
  }

  async function acceptBattle() {
    if (!battle || !wallet || !cfg.data) return;
    if (!ready) { setBattleErr(squadHint); return; }
    setBusy(true);
    try {
      const { signature } = await sendArenaTx(connection, wallet, async () => {
        const proofs = await squadProofs();
        const ix = acceptCompressedBattleV2Ix({
          opponent: wallet.publicKey, challenger: battle.challenger, nonce: battle.nonce,
          squad: proofs, delegates: proofs.map((x) => x.delegate), cgMint: cfg.data!.cgMint,
        });
        return [ix];
      }, { lookupTable: LOOKUP_TABLE });
      toast({ kind: 'money', title: { key: 'arena.acceptOpened' }, body: { key: 'screens.escrowed', params: { amount: amountText(battle.wager, 'CG') } }, href: EXPLORER.tx(signature) });
      setBattle(null); setInvite(null);
    } catch (e) {
      toast({ kind: 'error', title: { key: 'arena.acceptFailed' }, error: e, href: e instanceof TxError && e.signature ? EXPLORER.tx(e.signature) : undefined });
    } finally { setBusy(false); }
  }

  return (
    <div className="page stack page-bg page-bg-arena">
      <div className="row between">
        <div>
          <h1 className="page-title">{t('arena.title')}</h1>
          <p className="page-sub">{t('arena.subtitle')}</p>
        </div>
        <Link to="/leaderboard/rating" className="btn btn-sm">{t('ui.ranks')}</Link>
      </div>

      {connected && (
        <div className="grid-3">
          <div className="card"><Stat label={`${t('leaderboard.boards.rating')} · ${me.data ? leagueName(me.data.league ?? 0) : ''}`} value={me.isLoading ? <Skeleton h={22} w={60} /> : Math.round(me.data?.rating ?? MATCHMAKING.startRating)} /></div>
          <div className="card"><Stat label={t('ui.winsGames')} value={`${me.data?.wins ?? 0} / ${me.data?.games ?? 0}`} /></div>
          <div className="card"><Stat label={t('ui.rewardedLeft')} value={`${me.data?.rewardedMatchesLeft ?? MATCH_REWARDS.dailyRewardedMatches}/${MATCH_REWARDS.dailyRewardedMatches}`} /></div>
        </div>
      )}

      <div className="card stack">
        <div className="row between"><span className="strong">{t('arena.squad')}</span><span className="muted small">{t('ui.minPower')} {MIN_SQUAD_POWER}</span></div>
        <div className="row-wrap between">
          <span className="tiny muted">{t('arena.stakedAllowed')}</span>
          <button className="btn btn-sm" onClick={() => setPick(true)}>{t('ui.pickSquad')}</button>
        </div>
        <div className="squad">
          {[0, 1, 2].map((i) => {
            const c = squad[i];
            return (
              <div key={i} className="stack-sm center" onClick={() => setPick(true)} style={{ cursor: 'pointer' }}>
                {c ? <ChipArt collection={c.collection!} rarity={c.rarity!} index={c.index} level={c.level} imageUrl={chipImageOf(c)} skin={c.skin} crimp={rarityColor(c.rarity!)} /> : <div className="slot squad-slot-empty" style={{ aspectRatio: 1 }}><span className="squad-slot-plus" aria-hidden="true">+</span></div>}
                <div className="tiny">{c ? <><ElementGlyph element={ELEMENT_OF_COLLECTION[c.collection!]} /> {chipPower(c.rarity!, c.level!)} {t('ui.power')}</> : t('ui.pick')}</div>
              </div>
            );
          })}
        </div>
        <div className="row-wrap between">
          <div className="row" style={{ gap: 14 }}>
            <Stat label={t('ui.squadPower')} value={fmtDecimal(power, 0)} />
            <Stat label={t('ui.synergy')} value={`×${fmtDecimal(synergy)}`} />
            <Stat label={t('arena.league')} value={leagueName(league)} mono={false} />
          </div>
          {squad.length > 0 && <button className="btn btn-sm btn-ghost" onClick={() => setSquad([])}>{t('ui.clear')}</button>}
        </div>
        <div className="tiny muted">{t('arena.ring')}</div>

        {current ? (
          <div className="warn row between" style={introStyle}>
            <span>{current.iRevealed ? t('screens.opponentWait', { opponent: current.opponent.startsWith('bot:') ? t('ui.bot') : shortKey(current.opponent), time: countdown(current.revealDeadline) }) : t('screens.opponentReveal')}</span>
            <Link to={`/arena/match/${current.id}`} className="btn btn-sm">{t('ui.open')}</Link>
          </div>
        ) : queued || me.data?.queue ? (
          <div className="warn row between" style={introStyle}>
            <span>{t('ui.queueStatus', { league: leagueName(me.data?.queue?.league ?? league), ticket: (queued?.ticket ?? me.data?.queue?.ticket ?? '').slice(0, 6), s: MATCHMAKING.botFillAfterSec })}</span>
            <button className="btn btn-sm" onClick={async () => { await leave.mutateAsync(); setQueued(null); void me.refetch(); }}>{t('ui.leave')}</button>
          </div>
        ) : (
          <div className="grid-2">
            <SprayNozzleButton disabled={!ready || busy || !connected} onClick={joinRanked}>{t('ui.rankedMatch')}</SprayNozzleButton>
            <button className="btn" disabled={!ready || busy || !connected} onClick={() => setWager('')}>{t('ui.wagerBattle')}</button>
          </div>
        )}
        {connected && squadHint && <div className="warn small" role="status">{squadHint}</div>}
        {!connected && <div className="muted small">{t('ui.connectPlay')}</div>}
        {lastMatch && (
          <div className="row between small" style={{ color: lastMatch.won ? 'var(--cg-acid-green)' : 'var(--cg-neon-magenta)' }}>
            <span>{lastMatch.won === null ? t('ui.matchFinished') : lastMatch.won ? t('arena.youWon') : t('arena.youLost')}</span>
            <Link to={`/arena/match/${lastMatch.id}`} className="btn btn-sm">{t('arena.replay')}</Link>
          </div>
        )}
      </div>

      {(me.data?.recent?.length ?? 0) > 0 && (
        <div className="card stack-sm">
          <div className="strong">{t('ui.recentMatches')}</div>
          {me.data!.recent!.slice(0, 5).map((r) => (
            <Link key={r.id} to={`/arena/match/${r.id}`} className="row between small" style={{ textDecoration: 'none' }}>
              <span>{r.won ? `◀ ${t('screens.win')}` : `▶ ${t('screens.loss')}`}{r.forfeit ? ` (${t('screens.forfeit')})` : ''} {t('ui.vs')} {r.opponent!.startsWith('bot:') ? t('ui.bot') : shortKey(r.opponent)}</span>
              <span className="mono muted">{r.reward && r.reward !== '0' ? `+${fmtCg(r.reward, 1)}` : '—'}</span>
            </Link>
          ))}
          {me.data?.pendingRewardMicro && me.data.pendingRewardMicro !== '0' && <div className="tiny muted">{t('screens.pendingMatchRewards', { amount: fmtCg(me.data.pendingRewardMicro, 1) })}</div>}
        </div>
      )}

      <div className="card stack-sm">
        <div className="row between">
          <span className="strong">{t('ui.season')} {season.data?.id ?? '—'}</span>
          <span className="muted small">{t('common.endsIn', { time: season.data ? countdown(season.data.endsAt!) : '—' })}</span>
        </div>
        <div className="small">{t('ui.pool')} <b className="mono">{season.data ? fmtCg(season.data.poolCgMicro, 0) : '—'}</b> · {t('screens.seasonRewards', { weeks: SEASON.weeks, rewards: SEASON.chipRewardByLeague.join(' / '), days: SEASON.soulboundDays })}</div>
        <div className="tag-list">{(season.data?.brackets ?? SEASON.payoutBrackets).map((b) => <span key={b.topPct} className="pill">{t('screens.topShare', { top: b.topPct, share: b.sharePct })}</span>)}</div>
        {me.data?.seasonRank && <div className="small">{t('ui.yourRank')} <b className="mono">#{me.data.seasonRank}</b> · {t('screens.projected', { value: me.data.projectedBracket ?? '—' })}</div>}
        <div className="tiny muted">{t('screens.seedFairness')}{season.data?.serverSecretHash ? <> {t('screens.hash')}<span className="mono">{season.data.serverSecretHash.slice(0, 16)}…</span></> : null}</div>
      </div>

      <div className="card stack-sm">
        <div className="row between"><span className="strong">{t('arena.acceptTitle')}</span><span className="muted small">{t('arena.acceptHint')}</span></div>
        {invite ? (
          <>
            <div className="tag-list">
              <span className="pill mono">{t('arena.inviteChallenger')}: {invite.challenger}</span>
              <span className="pill mono">{t('arena.inviteNonce')}: {invite.nonce}</span>
            </div>
            <div className="row-wrap">
              <button className="btn btn-sm" onClick={() => { const u = new URL(window.location.href); u.searchParams.set('challenger', invite.challenger); u.searchParams.set('nonce', invite.nonce); void navigator.clipboard?.writeText(u.toString()); toast({ kind: 'info', title: { key: 'arena.inviteCopied' } }); }}>{t('arena.inviteCopy')}</button>
              <button className="btn btn-sm btn-ghost" onClick={() => { setInvite(null); setBattle(null); setBattleErr(null); }}>{t('ui.clear')}</button>
            </div>
          </>
        ) : (
          <CleanZone>
            <input className="input mono" placeholder={t('arena.acceptChallenger')} value={urlChallenger} disabled />
            <input className="input mono" inputMode="numeric" placeholder={t('arena.acceptNonce')} onChange={(e) => setInvite({ challenger: urlChallenger, nonce: e.target.value })} />
          </CleanZone>
        )}
        {invite && !battle && (
          <button className="btn btn-sm" disabled={busy || !connected} onClick={() => void loadBattle()}>{t('arena.acceptLoad')}</button>
        )}
        {battleErr && <div className="tiny" style={{ color: 'var(--cg-neon-magenta)' }}>{battleErr}</div>}
        {battle && (
          <div className="stack-sm">
            <KV k={t('arena.battleWager')} v={fmtCg(battle.wager)} />
            <KV k={t('arena.pot')} v={fmtCg(wagerSplit(battle.wager).pot)} />
            <KV k={t('arena.battleStatus')} v={BATTLE_STATUS[battle.status] ?? battle.status} />
            <KV k={t('arena.league')} v={leagueName(leagueOf(battle.powerA))} />
            <div className="tiny muted">{t('arena.squadLocked')}</div>
            <div className="tiny muted">{t('arena.lookupSetup')}</div>
            <CleanConfirmButton disabled={busy || !connected || !ready} onClick={() => void acceptBattle()}>
              {t('arena.acceptConfirm', { amount: fmtCg(battle.wager) })}
            </CleanConfirmButton>
            {squadHint && <div className="tiny muted">{squadHint}</div>}
          </div>
        )}
      </div>

      <Modal open={pick} onClose={() => setPick(false)} title={t('ui.pickSquad')} wide>
        <div className="stack-sm" style={{ marginBottom: 12 }} aria-live="polite">
          <div className="mono">{t('ui.squadPower')}: {fmtDecimal(power, 0)} / {MIN_SQUAD_POWER} · {squad.length}/3</div>
          {squadHint && <div className="warn small">{squadHint}</div>}
          <div className="tiny muted">{t('arena.stakedAllowed')}</div>
        </div>
        <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(144px, 47%), 1fr))' }}>
          {all.map((c) => {
            const sel = squad.some((s) => s.asset === c.asset);
            return (
              <div key={c.asset} className="chip-card" onClick={() => setSquad((s) => (sel ? s.filter((x) => x.asset !== c.asset) : s.length < 3 ? [...s, c] : s))}>
                <ChipArt collection={c.collection!} rarity={c.rarity!} index={c.index} level={c.level} imageUrl={chipImageOf(c)} skin={c.skin} badge={c.flags?.staked ? t('collection.filters.staked') : undefined} selected={sel} dim={!sel && squad.length >= 3} />
                <div className="chip-meta"><span style={{ color: rarityColor(c.rarity!) }}>{rarityName(c.rarity!)}</span> · {chipPower(c.rarity!, c.level!)} {t('ui.power')}</div>
                <div className="tiny muted">{chipName(c.collection!, c.rarity!)}</div>
              </div>
            );
          })}
        </div>
        <button className="btn btn-block" style={{ marginTop: 12 }} onClick={() => setPick(false)}>{t('ui.doneCount', { n: squad.length })}</button>
      </Modal>

      <Modal open={wager !== null} onClose={() => setWager(null)} title={t('ui.wagerBattle')}>
        <div className="stack">
          <div className="small muted">{t('arena.escrowNote')}</div>
          <div className="small muted">{t('arena.lookupSetup')}</div>
          <div className="small muted">{t('arena.squadLocked')}</div>
          <div className="tag-list">{[5, 25, 100, 500].map((v) => <Pill key={v} active={wager === String(v)} onClick={() => setWager(String(v))}>{v} $CG</Pill>)}</div>
          <CleanZone>
            <input className="input mono" inputMode="decimal" placeholder="5 – 5000" value={wager ?? ''} onChange={(e) => setWager(e.target.value)} />
            {(() => { const a = parseUnits(wager ?? '', 6); if (!a) return null; const s = wagerSplit(a); return <>
              <KV k={t('ui.yourStake')} v={fmtCg(a)} />
              <KV k={t('arena.pot')} v={fmtCg(s.pot)} />
              <KV k={t('arena.rake')} v={`− ${fmtCg(s.rake)}`} />
              <KV k={t('arena.payout')} v={fmtCg(s.payout)} total accent />
            </>; })()}
          </CleanZone>
          <CleanConfirmButton disabled={!ready || busy || !parseUnits(wager ?? '', 6) || parseUnits(wager ?? '', 6)! < MIN_WAGER || parseUnits(wager ?? '', 6)! > MAX_WAGER} onClick={() => createWager(parseUnits(wager ?? '', 6)!)}>{t('ui.escrowOpen')}</CleanConfirmButton>
          <div className="tiny muted">{t('ui.wagerRefund')}</div>
        </div>
      </Modal>
    </div>
  );
}
