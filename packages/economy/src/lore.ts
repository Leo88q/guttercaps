// THE single source of truth for GUTTERCAPS lore: 8 collections × 9 caps (districts 08 Brakeless and
// 09 Inked Streets were cut from the universe by owner decision on 2026-09-19 — see docs/07-art-spec.md).
// Lives in `@guttercaps/economy` so that all four consumers read the same object:
//   * the client (`client/src/shared/lib/lore.ts` is a re-export of this file),
//   * the backend API (`/collections/{idx}/chips/{rarity}`, `GET /chips/{asset}`),
//   * `scripts/setup.ts` (the 8 `create_collection` instructions — `symbol` is the
//     on-chain Core collection symbol, max 16 ASCII bytes), which imports this file
//     directly: the script runs under bare Node, where the client's `@/…` re-export
//     does not resolve,
//   * the marketing landing (`scripts/landing/collections.js`), whose 72 names are
//     asserted against this file by `npm run landing:check` (they used to drift silently).

export interface ChipLore {
  name: string;
  desc: string;
}

export interface CollectionLore {
  num: string;
  symbol: string; // <=16 ASCII chars — used as the on-chain Collection seed
  name: string;
  district: string;
  theme: string;
  color: string; // CSS var name, matches the site's palette tokens
  history: string;
  caps: ChipLore[]; // exactly 9, in tier order: Common..Diamond
}

export const RARITY_ORDER = [
  'Common', 'Common+', 'Rare', 'Rare+', 'Epic', 'Epic+', 'Legend', 'Legend+', 'Diamond',
] as const;

export const COLLECTIONS: CollectionLore[] = [
  {
    num: '01', symbol: 'NIGHTMOTH', name: 'Night Moth', district: 'The Old Industrial Quarter',
    theme: 'Stencil street art, an anonymous painter', color: 'var(--cyan)',
    history: "Once every new moon, a stencil shows up on a warehouse wall with no warning — always a moth, always doing something new: carrying a briefcase, sitting behind bars, holding a ballot. Nobody has ever seen the artist; the city just calls them Moth. Cleanup crews buff it out by morning, but a crew of ex-urban-explorers called the Keepers started photographing every piece first — and found a single bottle cap left at the base of each one. That cap is the first charged chip anyone can point to. Collection 01 is the actual origin story of Gutter Caps.",
    caps: [
      { name: 'Quick Moth', desc: 'A rough one-layer throw-up, still wet at the edges.' },
      { name: 'Moth, Caught by a Second Rain', desc: 'Same sketch, glossed by a repeat flood.' },
      { name: 'Moth with a Briefcase', desc: 'Multi-layer piece with a pointed social jab.' },
      { name: 'Moth with a Briefcase — Second Coat', desc: 'Repainted over the buffed original.' },
      { name: 'Moth Behind Bars', desc: 'The piece the whole block argued about for a week.' },
      { name: 'Moth Behind Bars — The Record', desc: 'Same scene, now dated and signed.' },
      { name: 'The Night of Three Walls', desc: 'Three pieces, three districts, same night.' },
      { name: 'The Night of Three Walls — Wall Four', desc: 'An unconfirmed fourth sighting.' },
      { name: 'The Real Charge', desc: 'The first cap ever left at the first piece. One exists.' },
    ],
  },
  {
    num: '02', symbol: 'ASPHALTDEV', name: 'Asphalt Devils', district: 'The Drained Pools',
    theme: 'Skate & BMX', color: 'var(--orange)',
    history: "A drought once emptied every public pool in the district, and bored teens turned the concrete bowls into a skatepark nobody approved. The self-titled Dry Concrete Clan built its reputation on shaky camcorder footage, and every legend got taller in the retelling — someone rode a whole week on two broken legs, someone cleared a fence nobody's cleared since. The pools got demolished for condos years ago. The chips carrying each trick's name are still the only currency that matters here.",
    caps: [
      { name: 'First Roll-In', desc: 'Dropping into the bowl for the very first time.' },
      { name: 'Second Run', desc: 'Same drop, landed clean on the retry.' },
      { name: 'Blind Grind', desc: 'A grind held without ever looking down.' },
      { name: 'Blind Grind — Clean Exit', desc: 'The same line, finally landed smooth.' },
      { name: 'Fence Jump', desc: 'Cleared the guarded fence line in one shot.' },
      { name: 'Fence Jump — The Return', desc: 'Same jump, back over, in broad daylight.' },
      { name: 'Bone Leg', desc: 'Rode a full week on two broken legs, they say.' },
      { name: 'Bone Leg — Rematch', desc: 'Same story, two breaks later.' },
      { name: '540 on the Roof', desc: 'No footage exists. Only witnesses.' },
    ],
  },
  {
    num: '03', symbol: 'RAILKINGS', name: 'Rail Kings', district: 'The Freight Yard',
    theme: 'Train bombing', color: 'var(--magenta)',
    history: "Crews here don't fight for a wall, they fight for a car — a whole train that carries a name into cities the crew will never set foot in. The yard's night guards are known only as the Watchers. A piece's status used to be tracked in a hand-written logbook of sightings across stations; now that sighting log lives on-chain instead, and it can't be edited after the fact no matter how many yards a car passes through.",
    caps: [
      { name: 'Quick Tag', desc: 'One line, sprayed in the minute before departure.' },
      { name: 'Quick Tag — Second Car', desc: 'Same writer, same night, one car over.' },
      { name: 'One-Night Burner', desc: 'A full piece finished before sunrise, no second chances.' },
      { name: 'One-Night Burner — Follow-Up', desc: 'Finished off at the next stop down the line.' },
      { name: 'Ran Three States', desc: 'Confirmed sightings across three separate regions.' },
      { name: 'Ran Three States — Kept Going', desc: 'Spotted even further out.' },
      { name: 'The Invisible Car', desc: "Painted inside a yard nobody should've gotten into." },
      { name: 'The Invisible Car — Second Run', desc: 'Same crew went back for more.' },
      { name: 'The Never-Ending Ride', desc: 'Never buffed. Still rolling, ten years on.' },
    ],
  },
  {
    num: '04', symbol: 'GUTTERSOLE', name: 'Gutter Soles', district: 'The Overpass Market',
    theme: 'Sneaker culture, restoration', color: 'var(--trust)',
    history: 'Every flood season drowns part of the flea market under the overpass, and unsold stock washes into the drain. Divers fish the waterlogged pairs back out, and a street cobbler known only as Rusty Stitch brings them back to life with a signature thread color that became this whole collection\'s charge signature. Fakes are the eternal sneakerhead problem — which is exactly why on-chain provenance matters more here than anywhere else in the game.',
    caps: [
      { name: 'Soaked Pair', desc: 'A basic restoration, straight out of the drain.' },
      { name: 'Soaked Pair — Second Flood', desc: 'Caught again, restitched a second time.' },
      { name: 'Double Stitch', desc: "Two parallel threads in the collection's signature color." },
      { name: 'Double Stitch — Triple Pass', desc: 'A third thread added to the pattern.' },
      { name: 'One-Storm Batch', desc: 'Stitched during a single named storm. Never repeated.' },
      { name: 'One-Storm Batch — Second Wave', desc: 'An extra batch from the same storm.' },
      { name: "The Cobbler's Last Pair", desc: "One of Rusty Stitch's final known pieces." },
      { name: "The Cobbler's Last Pair — Found Later", desc: 'Turned up years after he vanished.' },
      { name: 'The Original First', desc: 'The very first pair he ever restored.' },
    ],
  },
  {
    num: '05', symbol: 'BOOMBOXBLK', name: 'Boombox Block', district: 'The Block',
    theme: 'Hip-hop, breaking, MC battles', color: 'var(--acid)',
    history: "Every summer, the block throws a party running on power borrowed from a streetlamp — nobody calls that a crime, they call it tradition. Breaking circles crown local legends, MCs trade bars until sunrise, and boomboxes get handed down like relics. The chips started as literal battle-winner tokens, long before the idea spread to the rest of the city.",
    caps: [
      { name: 'First Scratch', desc: 'A basic DJ move, nothing fancy.' },
      { name: 'First Scratch — Encore', desc: 'Same move, repeated for a louder crowd.' },
      { name: 'Windmill on the Asphalt', desc: "A breaking move most people can't land." },
      { name: 'Windmill on the Asphalt — Double Spin', desc: 'The harder version of the same move.' },
      { name: 'Two MCs, One Mic', desc: 'The token for winning a battle everyone remembers.' },
      { name: 'Two MCs, One Mic — Rematch', desc: 'Same two, trading places this time.' },
      { name: 'The Boombox That Never Stopped', desc: 'Ran 72 hours straight on stolen power.' },
      { name: 'The Boombox That Never Stopped — Night Two', desc: 'Same box, survived a repeat.' },
      { name: "The Block's First Party", desc: 'The token from the party that started it all.' },
    ],
  },
  {
    num: '06', symbol: 'GUTTERBEAS', name: 'Gutter Beasts', district: 'The Sewers & Back Alleys',
    theme: 'Urban wildlife folklore', color: 'var(--cyan)',
    history: "Kids in this city have always told each other about the hidden animal kingdom underneath it: a one-eyed cat that runs a whole block, a pigeon flock that seems to vote on rooftops, raccoons that hit dumpsters with military timing. None of them are villains — just tricky spirits of the street. This is the most literal Gutter Caps collection there is: the chips physically surface from the same drains these creatures are said to live in.",
    caps: [
      { name: 'Scout Pigeon', desc: 'A rooftop lookout, nothing more.' },
      { name: 'Scout Pigeon — Second Nest', desc: 'Same bird, new rooftop claimed.' },
      { name: 'One-Eyed Cat of the Block', desc: 'The unofficial watchman of the neighborhood.' },
      { name: 'One-Eyed Cat of the Block — New Mark', desc: 'One more block claimed as territory.' },
      { name: 'The Raccoon Squad', desc: 'Three raccoons, one dumpster, perfect timing.' },
      { name: 'The Raccoon Squad — Second Raid', desc: 'Same crew, bigger score.' },
      { name: 'Queen of the Roofs', desc: "The pigeon matriarch nobody's fully described." },
      { name: 'Queen of the Roofs — New Brood', desc: 'Word of her offspring spreads.' },
      { name: 'The Thing That Lives Under the City', desc: 'Never fully seen. Never will be.' },
    ],
  },
  {
    num: '07', symbol: 'PIXELBASE', name: 'Pixel Basement', district: 'The Basement Arcades',
    theme: 'Retro arcade culture', color: 'var(--magenta)',
    history: "When the real arcades shut down, their cabinets sold for scrap and ended up rebuilt in basements nobody advertises. The games running there are half-broken and half-invented — nobody remembers the real names anymore. High-scorers who scratch initials into a board that's never been wiped run the place; glitch-hunters who find a game-breaking exploit earn their own kind of respect.",
    caps: [
      { name: 'First Coin', desc: 'Just another quarter dropped in the slot.' },
      { name: 'First Coin — Continue', desc: 'The same player, feeding it a second coin.' },
      { name: 'Secret Level', desc: 'A hidden stage nobody was supposed to find.' },
      { name: 'Secret Level — Second Route', desc: 'The same level, cleared a different way.' },
      { name: 'High Score on a Broken Cabinet', desc: 'Set on a machine everyone wrote off.' },
      { name: 'High Score on a Broken Cabinet — Beaten', desc: 'Same player broke their own record.' },
      { name: 'Triple Zero', desc: 'A supposedly perfect score, still disputed today.' },
      { name: 'Triple Zero — Repeat', desc: 'Rumor of the same score, done again.' },
      { name: "The Cabinet That Doesn't Exist", desc: 'Seen once, in a different basement each time.' },
    ],
  },
  {
    num: '10', symbol: 'CITYMYTHS', name: 'City Myths', district: 'The whole city',
    theme: 'Meta-collection: legends about the other seven', color: 'var(--acid)',
    history: "This is where the folklore around all seven other scenes finally gets written down — the rumors about Moth, the arguments about the Invisible Car, the stories about the thing under the city. City Myths doesn't repeat any chip from the other seven collections; it lives in the moments where their stories cross. It's built to launch last, as a season for players who already know the rest of the lore — and its Diamond chip closes the loop straight back to Collection 01.",
    caps: [
      { name: 'Street Rumor', desc: 'Just another story making the rounds.' },
      { name: 'Street Rumor — Retold', desc: 'The same story, changed in the retelling.' },
      { name: 'Legend, Written Down', desc: 'A story someone finally bothered to record.' },
      { name: 'Legend, Written Down — Footnote', desc: 'The same account, with new details added.' },
      { name: 'Where Two Stories Cross', desc: "A moment where two districts' legends meet." },
      { name: 'Where Two Stories Cross — A Third District', desc: 'The same crossing, now with a third scene involved.' },
      { name: "The Night the City Didn't Sleep", desc: 'All eight districts, one impossible night.' },
      { name: "The Night the City Didn't Sleep — Again?", desc: 'An unconfirmed rumor of a second one.' },
      { name: 'The First Rumor', desc: 'The myth this entire culture is said to have started from.' },
    ],
  },
];

export function findCollectionBySymbol(symbol: string): CollectionLore | undefined {
  return COLLECTIONS.find((c) => c.symbol === symbol);
}

/** Looks up the real chip name for a (collection, rarity) pair — this is
 * what reveal_chip_metadata should be called with once open_pack's
 * PackOpened event reveals the rolled rarity. */
export function chipNameFor(symbol: string, rarity: string): string {
  const collection = findCollectionBySymbol(symbol);
  const tierIndex = RARITY_ORDER.indexOf(rarity as (typeof RARITY_ORDER)[number]);
  if (!collection || tierIndex === -1) return 'Unknown Cap';
  return collection.caps[tierIndex].name;
}
