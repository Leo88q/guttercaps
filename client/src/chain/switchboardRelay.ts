export class SwitchboardUnavailable extends Error {
  readonly code = 'switchboard_unavailable';
  constructor(public details: unknown) { super('Switchboard unavailable; no new wager or purchase should be submitted.'); }
}
