# -*- coding: utf-8 -*-
"""Landing copy in EN + RU. Every value is (en, ru).
Numbers here MUST mirror packages/economy (tokenomics.ts, packs.ts, fusion.ts,
staking.ts, pvp.ts, faucets.ts, services.ts) — see scripts/landing/check.py.
"""

T = {
  'nav.world': ('World', 'Мир'), 'nav.how': ('How to play', 'Как играть'), 'nav.districts': ('Districts', 'Районы'),
  'nav.rarity': ('Rarity', 'Редкость'), 'nav.packs': ('Packs', 'Паки'), 'nav.economy': ('Economy', 'Экономика'),
  'nav.roadmap': ('Roadmap', 'Роадмап'), 'nav.faq': ('FAQ', 'FAQ'), 'nav.open': ('Open app', 'Открыть игру'),
  'skip': ('Skip to content', 'К содержимому'),

  'hero.eyebrow': ('On Solana · built for Seeker · 7 languages', 'На Solana · сделано для Seeker · 7 языков'),
  'hero.sub': ('Seventy-two bottle caps from a city that never dries. Pull them from provably-fair packs, fuse three into one, slam them in the arena, stake them for $CG — every cap is a real asset in your wallet and every roll can be checked on-chain.',
               'Семьдесят две крышки из города, который никогда не сохнет. Доставайте их из доказуемо честных паков, сливайте три в одну, бейтесь на арене, стейкайте за $CG — каждая фишка реально лежит в вашем кошельке, а каждый ролл можно проверить в блокчейне.'),
  'hero.p1': ('8 districts × 9 tiers = 72 caps', '8 районов × 9 тиров = 72 фишки'),
  'hero.p2': ('On-chain SlotHashes, never a studio roll', 'Ончейн-SlotHashes, не ролл студии'),
  'hero.p3': ('Pay in SOL · USDC · SKR', 'Оплата в SOL · USDC · SKR'),
  'hero.p4': ('3 → 1 fusion', 'Фьюжн 3 → 1'),
  'hero.p5': ('Cap Slam 3-v-3', 'Cap Slam 3 на 3'),
  'hero.cta': ('Open the app', 'Открыть игру'),
  'hero.cta2': ('Starter pack — $1.99', 'Стартовый пак — $1.99'),
  'hero.note': ('Works with Phantom, Solflare, Backpack and the Seeker wallet. Every pack paid in SKR is 5 % cheaper.',
                'Работает с Phantom, Solflare, Backpack и кошельком Seeker. Любой пак, оплаченный в SKR, на 5 % дешевле.'),

  'world.h': ('Gutter City <span class="tag-accent">never dries</span>', 'Gutter City <span class="tag-accent">никогда не сохнет</span>'),
  'world.p': ("The lore behind every pack you open — why a bottle cap can carry a whole scene's reputation, and why that had to end up on-chain.",
              'Лор за каждым паком — почему крышка от бутылки может нести репутацию целой сцены и почему это должно было оказаться в блокчейне.'),
  'world.body': ("Gutter City never really dries out. Every storm drain in the old quarters backs up sooner or later, and when it does, the flood drags up everything the streets have swallowed — including bottle caps that sat close enough to a scene to soak up its charge. A cap that lay under a legendary wall, a drained pool, a freight yard or a basement arcade comes back different: heavier, brighter, marked. The city's collectors call it a <em>charged cap</em>. Eight districts, nine levels of charge, and a second flood that turns any story into its \"+\" chapter — that is the whole collection.",
                 'Gutter City никогда не просыхает. Каждая ливнёвка старых кварталов рано или поздно захлёбывается, и тогда поток выносит всё, что улицы успели проглотить — в том числе крышки, лежавшие достаточно близко к сцене, чтобы впитать её заряд. Крышка из-под легендарной стены, осушенного бассейна, товарного двора или подвальной аркады возвращается другой: тяжелее, ярче, с меткой. Городские коллекционеры зовут её <em>заряженной</em>. Восемь районов, девять уровней заряда и второй потоп, который превращает любую историю в её «+»-главу — это и есть вся коллекция.'),
  'world.f1': ('8 districts, 1 flooded city', '8 районов, 1 затопленный город'),
  'world.f2': ('A cap charges from whatever scene it lands near', 'Крышка заряжается от сцены, рядом с которой лежала'),
  'world.f3': ('"+" tiers survived a second flood', '«+»-тиры пережили второй потоп'),
  'world.f4': ('Provenance lives on-chain, not in a logbook', 'Происхождение хранится в блокчейне, а не в тетрадке'),

  'how.h': ('How to <span class="tag-accent">play</span>', 'Как <span class="tag-accent">играть</span>'),
  'how.p': ('Five moves from an empty wallet to a full district. Everything that touches money happens in transactions you sign yourself — the buy in one, the reveal and settlement relayed by our crank.',
            'Пять шагов от пустого кошелька до полного района. Всё, что касается денег, происходит в транзакциях, которые подписываете вы сами: покупка — в одной, раскрытие и расчёт релеит наш crank.'),

  'districts.h': ('The eight <span class="tag-accent">districts</span>', 'Восемь <span class="tag-accent">районов</span>'),
  'districts.p': ('Every collection is a real district of Gutter City — its own scene, its own myth, nine caps running from a first throw-up to a one-of-one. Final artwork lands per cap as it is ready; every slot is already wired up on-chain.',
                  'Каждая коллекция — настоящий район Gutter City: своя сцена, свой миф, девять фишек от первого наброска до единственного экземпляра. Финальный арт появляется по мере готовности; каждый слот уже заведён в блокчейне.'),

  'rarity.h': ('The <span class="tag-accent">charge scale</span>', 'Шкала <span class="tag-accent">заряда</span>'),
  'rarity.p': ('Standard-pack odds as stored in the program config, published here from the same table. Rarity reads through colour, rim and glow — never through size. Base power feeds the arena; stake weight feeds staking.',
               'Шансы Standard-пака — как в конфиге программы, опубликованы здесь из той же таблицы. Редкость читается по цвету, ободку и свечению — никогда по размеру. Базовая сила идёт в арену, вес стейка — в стейкинг.'),
  'rarity.pity': ('Pity: a Standard pack guarantees a Legend by the 60th pack without one (soft boost from the 30th); Premium by 40, Limited by 25. The counter is stored in your own on-chain account.',
                  'Pity: Standard-пак гарантирует Legend не позже 60-го пака без него (мягкий буст с 30-го); Premium — к 40-му, Limited — к 25-му. Счётчик хранится в вашем собственном аккаунте в блокчейне.'),

  'packs.h': ('Four <span class="tag-accent">packs</span>', 'Четыре <span class="tag-accent">пака</span>'),
  'packs.p': ('Prices are fixed in US cents; SOL and SKR convert at a frozen studio rate (SOL = $110, SKR = $0.016). $CG packs burn 75 % of the price.',
              'Цены зафиксированы в центах США; SOL и SKR пересчитываются по фиксированному курсу студии (SOL = $110, SKR = $0.016). Паки за $CG сжигают 75 % цены.'),
  'packs.bundles': ('Bundles: ×5 −7 % · ×10 −12 % · ×25 −18 %. Paying in SKR takes another 5 % off (stacks, capped at 30 %). Limited packs: max 5 per wallet per day, no bundles.',
                    'Бандлы: ×5 −7 % · ×10 −12 % · ×25 −18 %. Оплата в SKR даёт ещё −5 % (суммируется, потолок 30 %). Limited-паки: не более 5 на кошелёк в день, без бандлов.'),

  # Mainnet pre-sale (docs/preorder-beta.md) — numbers mirror backend/src/config.ts
  # PREORDER_* defaults and are pinned against them by scripts/landing/check.ts.
  'presale.h': ('Founder <span class="tag-accent">pre-sale</span>', 'Пре-сейл <span class="tag-accent">для первых</span>'),
  'presale.p': ('The beta is free and runs on devnet; mainnet comes after the audit. Until then two Limited Event Pack offers sell for real SOL: 500 singles at 0.30 SOL (max 5 per wallet) and 125 founders chests of 4 packs at 0.999 SOL (max 1 per wallet). You pay today, the packs are delivered on-chain at mainnet launch, and you open them yourself — same on-chain SlotHashes, same published odds.',
                'Бета бесплатна и идёт на devnet; mainnet будет после аудита. До тех пор два предложения Limited-паков за реальные SOL: 500 одиночных по 0,30 SOL (макс. 5 на кошелёк) и 125 сундуков основателей из 4 паков по 0,999 SOL (макс. 1 на кошелёк). Вы платите сегодня, паки выдаются на цепи при запуске майнета, и вскрываете их вы сами — те же ончейн-SlotHashes, те же опубликованные шансы.'),
  'presale.o1h': ('Limited Event Pack', 'Limited Event Pack'),
  'presale.o1p': ('500 singles · 0.30 SOL · max 5 per wallet', '500 одиночных · 0,30 SOL · макс. 5 на кошелёк'),
  'presale.o2h': ('Founders chest ×4', 'Сундук основателей ×4'),
  'presale.o2p': ('125 chests · 0.999 SOL · max 1 per wallet', '125 сундуков · 0,999 SOL · макс. 1 на кошелёк'),
  'presale.c1h': ('Pay now — open at launch', 'Платите сейчас — вскрытие на запуске'),
  'presale.c1p': ('SOL goes to the team multisig (2-of-3) with the memo GC-PRE|42 style tag. At mainnet launch the packs are granted on-chain in reservation order and land in your wallet as pending packs you open yourself.',
                  'SOL уходит в мультиподпись команды (2-из-3) с мемо вида GC-PRE|42. При запуске майнета паки выдаются на цепи в порядке бронирования и ложатся в ваш кошелёк как ожидающие паки, которые вы вскрываете сами.'),
  'presale.c2h': ('The price is locked in SOL', 'Цена зафиксирована в SOL'),
  'presale.c2p': ('At launch the Limited Event Pack costs $29.99 at the frozen SOL rate ($110). Pre-sale singles are a flat 0.30 SOL; the founders chest is 0.999 SOL for 4 packs — no conversion, no slippage. 500 singles and 125 chests, 1000 packs on-chain.',
                  'На запуске Limited-пак стоит $29,99 по фиксированному курсу SOL ($110). Одиночный пак пре-сейла — ровно 0,30 SOL; сундук основателей — 0,999 SOL за 4 пака, без конвертации и проскальзывания. 500 одиночных и 125 сундуков, 1000 паков на цепи.'),
  'presale.c3h': ('5 caps, floor Rare+', '5 фишек, порог Rare+'),
  'presale.c3p': ('Only the featured seasonal collection, no cap below Rare+, Legend guaranteed by pack 25 — the strongest top-end odds in the game. Event packs exist to fund the prize pools.',
                  'Только сезонная избранная коллекция, ни одной фишки ниже Rare+, Legend гарантирован к 25-му паку — сильнейшие верхние шансы в игре. Событийные паки и существуют, чтобы наполнять призовые пулы.'),
  'presale.c4h': ('Public registry, visible terms', 'Публичный реестр, видимые условия'),
  'presale.c4p': ('Every reservation is listed in a public registry; a drop can only close once fully delivered, and the campaign can be switched off at any moment. Delivery has not happened yet — read the refund terms in the app before paying.',
                  'Каждая бронь видна в публичном реестре; дроп закрывается только после полной выдачи, а кампанию можно остановить в любой момент. Выдачи ещё не было — до оплаты прочитайте условия возврата в приложении.'),
  'presale.cta': ('Reserve packs in the app', 'Забронировать паки в приложении'),
  'presale.note': ('This is an advance purchase of mainnet packs, not a token sale: you receive exactly the packs you reserved, delivered at launch. The devnet beta stays free for everyone.',
                   'Это авансовая покупка майнет-паков, а не продажа токенов: вы получаете ровно те паки, что забронировали, с выдачей на запуске. Devnet-бета остаётся бесплатной для всех.'),

  'eco.h': ('<span class="tag-accent">$CG</span> and SKR', '<span class="tag-accent">$CG</span> и SKR'),
  'eco.p': ('Two currencies with two jobs. $CG is the game token: minted only by the program on a decaying schedule, burned by every sink. SKR — the Seeker token — is a payment rail and a prize currency: you pay with it, a fixed share of that revenue flows into an on-chain SKR prize pool, and the game never mints or burns it.',
            'Две валюты — две роли. $CG — игровой токен: его выпускает только программа по убывающему графику, а сжигает каждый sink. SKR — токен Seeker — это платёжный рельс и призовая валюта: им платят, фиксированная доля этой выручки идёт в on-chain призовой пул SKR, а игра его не выпускает и не сжигает.'),
  'eco.alloc': ('$CG allocation — 1 000 000 000 hard cap', 'Распределение $CG — жёсткий потолок 1 000 000 000'),
  'eco.a1': ('Play emission: staking, quests, PvP, seasons (7-year curve, 18 % → 4 % a year)', 'Игровая эмиссия: стейкинг, квесты, PvP, сезоны (7-летняя кривая, 18 % → 4 % в год)'),
  'eco.a2': ('Ecosystem & liquidity (20 % at TGE, then 24 months linear)', 'Экосистема и ликвидность (20 % на TGE, далее линейно 24 мес.)'),
  'eco.a3': ('Team & advisors (12-month cliff, then 36 months linear)', 'Команда и советники (клифф 12 мес., затем линейно 36 мес.)'),
  'eco.a4': ('Treasury / DAO reserve (multisig, on-chain proposals)', 'Казна / резерв DAO (мультисиг, on-chain-предложения)'),
  'eco.a5': ('Airdrops & referrals (max 1 % a quarter)', 'Эйрдропы и рефералы (не более 1 % в квартал)'),
  'eco.emission': ("Where each day's emission goes", 'Куда уходит дневная эмиссия'),
  'eco.e1': ('Cap staking', 'Стейкинг фишек'), 'eco.e2': ('$CG staking', 'Стейкинг $CG'), 'eco.e3': ('Quests', 'Квесты'),
  'eco.e4': ('PvP season & matches', 'PvP: сезон и матчи'), 'eco.e5': ('Events, referrals, jackpots', 'Ивенты, рефералы, джекпоты'),
  'eco.guard': ('Emission guard: the program mints at most min(schedule, 2 % of schedule + 1.25 × the trailing 7-day burn). If players stop burning, emission slows down by itself.',
                'Предохранитель эмиссии: программа выпускает не больше min(график, 2 % графика + 1,25 × средний burn за 7 дней). Если игроки перестают сжигать, эмиссия замедляется сама.'),
  'eco.sinks': ('Sinks — where $CG leaves circulation', 'Sinks — где $CG уходит из оборота'),
  'eco.s1': ('Fusion fees', 'Комиссии фьюжна'), 'eco.s2': ('Packs bought with $CG', 'Паки за $CG'), 'eco.s3': ('Early-unstake penalty', 'Штраф за ранний анстейк'),
  'eco.s4': ('PvP rake', 'Рейк PvP'), 'eco.s5': ('Market fee → weekly buyback', 'Комиссия маркета → еженедельный выкуп'), 'eco.s6': ('Extras paid in $CG', 'Экстры за $CG'),
  'eco.burned': ('share burned', 'доля сжигания'),
  'eco.fees': ('Fee schedule — all of it on-chain', 'Комиссии — всё в блокчейне'),
  'eco.f.what': ('What', 'Что'), 'eco.f.rate': ('Rate', 'Ставка'), 'eco.f.where': ('Where it goes', 'Куда идёт'),
  'eco.f1': ('Marketplace protocol fee', 'Комиссия маркетплейса'), 'eco.f1w': ('⅓ buys back and burns $CG weekly, ⅔ treasury. Live-tunable 0–10 %, hard-capped in code.', '⅓ еженедельно выкупает и сжигает $CG, ⅔ — казна. Настраивается 0–10 %, потолок зашит в код.'),
  'eco.f2': ('Creator royalty', 'Роялти создателя'), 'eco.f2w': ('Taken by the program on every sale it settles — 2.5 % to the treasury with the fee share, fixed in code.', 'Взимается программой с каждой продажи, которую она рассчитывает, — 2,5 % в казну вместе с долей комиссии, фиксировано в коде.'),
  'eco.f3': ('Cap Slam wager rake', 'Рейк ставок Cap Slam'), 'eco.f3w': ('40 % treasury · 40 % burned · 20 % season prize pool.', '40 % казна · 40 % сжигается · 20 % призовой фонд сезона.'),
  'eco.f4': ('Listing fee', 'Плата за листинг'), 'eco.f4w': ('Anti-spam; burned.', 'Антиспам; сжигается.'),
  'eco.f5': ('Extras (handle, skins, season pass…)', 'Экстры (хэндл, скины, сезонный пропуск…)'), 'eco.f5w': ('Cosmetic only — never odds, power or yield. $CG payments are burned; SOL/USDC/SKR go to the treasury.', 'Только косметика — никогда не шансы, сила или доход. Оплата в $CG сжигается; SOL/USDC/SKR идут в казну.'),
  'eco.f6': ('SKR pack discount', 'Скидка на паки в SKR'), 'eco.f6w': ('Seeker promo; live-tunable 0–15 %.', 'Промо Seeker; настраивается 0–15 %.'),
  'eco.skr.h': ('SKR — the Seeker token: pay with it, win it back', 'SKR — токен Seeker: платите им — и выигрывайте его'),
  'eco.skr.p': ('Packs, listings, offers and extras accept SKR at the frozen studio rate ($0.016). Only the genuine mint below is accepted — never a symbol lookup. Because the game cannot mint SKR, SKR prizes come from an on-chain prize pool funded by 15 % of SKR pack revenue (plus 10 % of SKR market fees and 5 % of SKR extras), paid in weekly from the public treasury wallet: Seeker-week quests, season ladders and tournaments pay out in SKR through the same Merkle claims as $CG, capped per wallet. Wagers, fusion fees and staking stay in $CG.',
                'Паки, листинги, офферы и экстры принимают SKR по фиксированному курсу студии ($0.016). Принимается только подлинный минт ниже — никакого поиска по тикеру. Поскольку игра не может выпускать SKR, призы в SKR идут из on-chain призового пула, который еженедельно пополняется с публичного казначейского кошелька: 15 % выручки паков за SKR (плюс 10 % комиссий маркета и 5 % экстра-сервисов в SKR): квесты Seeker-недели, сезонные ладдеры и турниры выплачиваются в SKR через те же Merkle-клеймы, что и $CG, с капом на кошелёк. Ставки, fusion-fee и стейкинг остаются в $CG.'),

  'mech.h': ('Everything you can <span class="tag-accent">do with a cap</span>', 'Всё, что можно <span class="tag-accent">сделать с фишкой</span>'),
  'mech.p': ('Numbers below are the live parameters of the devnet build — the same table the programs, the app and the economy tests read from.',
             'Числа ниже — живые параметры devnet-сборки: та же таблица, из которой читают программы, приложение и тесты экономики.'),
  'mech.1h': ('Fusion 3 → 1', 'Фьюжн 3 → 1'),
  'mech.1p': ('Three caps of one tier become one of the next. Every second step needs the same district. From Epic upward fusion can fail — 85 / 75 / 70 / 50 % — and refunds one material; a booster adds +15 pp (cap 95 %). Fees are burned; results are locked for up to 72 h.',
              'Три фишки одного тира становятся одной следующего. Каждый второй шаг требует один район. С Epic и выше фьюжн может провалиться — 85 / 75 / 70 / 50 % — и возвращает один материал; бустер даёт +15 п.п. (потолок 95 %). Комиссия сжигается; результат заблокирован до 72 ч.'),
  'mech.1f': ('fee 2.5 → 6 000 $CG', 'комиссия 2,5 → 6 000 $CG'),
  'mech.2h': ('Cap Slam', 'Cap Slam'),
  'mech.2p': ('3-v-3, best of three. Power × element edge × luck in [0.5, 1.5], resolved by the server from a commit-reveal seed and settled by the program. Wagers of 5–5 000 $CG sit in escrow; caps are never at risk. Six-week seasons with a prize pool from emission and rake.',
              '3 на 3, до двух побед. Сила × преимущество стихии × удача в [0,5; 1,5]; сервер считает бой по seed из commit-reveal, программа рассчитывает выплату. Ставки 5–5 000 $CG лежат в эскроу; фишки никогда не под угрозой. Шестинедельные сезоны с призовым фондом из эмиссии и рейка.'),
  'mech.2f': ('rake 5 % · 8 rewarded matches/day', 'рейк 5 % · 8 наградных матчей в день'),
  'mech.3h': ('Staking', 'Стейкинг'),
  'mech.3p': ('Stake caps (weight 1 → 2 200 by tier, × level) or $CG (flex / 30 / 90 / 180 days, boost 1.0 / 1.5 / 2.2 / 3.0). Claims mint at most 30 $CG/day from caps and 15 $CG/day from $CG locks; surplus stays in the pool. Skip Cap Slam for 7 days and chip weight drops to 25 %. Complete a district — all nine tiers — for +12 % per set, up to five sets. Early exit burns 5–15 %.',
              'Стейкайте фишки (вес 1 → 2 200 по тиру, × уровень) или $CG (flex / 30 / 90 / 180 дней, буст 1,0 / 1,5 / 2,2 / 3,0). Клейм минтит не больше 30 $CG/день с фишек и 15 $CG/день с локов $CG; излишек остаётся в пуле. Без Cap Slam 7 дней вес фишки падает до 25 %. Соберите район — все девять тиров — и получите +12 % за сет, до пяти сетов. Ранний выход сжигает 5–15 %.'),
  'mech.3f': ('APY is an output of TVL, never a promise', 'APY зависит от TVL и никогда не обещается'),
  'mech.4h': ('Market', 'Маркет'),
  'mech.4p': ('List in SOL, USDC or SKR; the cap is escrowed by the program and paid out to you directly. Offers in USDC. Floors per district × tier are tracked live; minimum prices stop dust listings.',
              'Листинг в SOL, USDC или SKR; фишка лежит в эскроу программы, выплата идёт напрямую вам. Офферы — в USDC. Флоры по району × тиру считаются живьём; минимальные цены отсекают «пыль».'),
  'mech.4f': ('7.5 % + 2.5 % royalty', '7,5 % + 2,5 % роялти'),
  'mech.5h': ('Quests', 'Квесты'),
  'mech.5p': ('Daily, weekly and permanent. Progress is counted only from on-chain events and server-resolved matches; rewards are claimed through Merkle roots with a fixed budget. Caps: 15 $CG a day, 120 a week, two free caps a week.',
              'Ежедневные, недельные и постоянные. Прогресс считается только по on-chain-событиям и серверным матчам; награды забираются через Merkle-корни с фиксированным бюджетом. Лимиты: 15 $CG в день, 120 в неделю, две бесплатные фишки в неделю.'),
  'mech.5f': ('anti-farm caps on every faucet', 'антифарм-лимиты на каждом источнике'),
  'mech.6h': ('Extras', 'Экстры'),
  'mech.6p': ('An @handle for $1.99, cap skins, profile themes, arena emotes, instant reveal, a $9.99 cosmetic season pass. None of it touches odds, power or yield — it is how the studio earns without selling advantage.',
              '@хэндл за $1.99, скины фишек, темы профиля, эмоции арены, мгновенное вскрытие, косметический сезонный пропуск за $9.99. Ничто из этого не влияет на шансы, силу или доход — так студия зарабатывает, не продавая преимущество.'),
  'mech.6f': ('$0.99 – $9.99 · SOL / USDC / SKR / $CG', '$0.99 – $9.99 · SOL / USDC / SKR / $CG'),
  'mech.7h': ('Drain &amp; Verify', 'Ливнёвки и проверка'),
  'mech.7p': ('Every morning the city asks you to lift a grate. That check-in is the daily login — 2 $CG, claimed on Quests. Every pack pulled from those streets is rolled from on-chain SlotHashes; paste the open transaction on Verify and recompute the exact rarities the program minted. Nobody, including us, picks the drop.',
              'Каждое утро город просит поднять решётку. Это ежедневный логин — 2 $CG, клейм в квестах. Каждый пак с этих улиц крутится из ончейн-SlotHashes: вставьте транзакцию открытия в «Проверку» и пересчитайте редкости, которые заминтила программа. Никто, включая нас, не выбирает дроп.'),
  'mech.7f': ('2 $CG/day · SlotHashes on Verify', '2 $CG/день · SlotHashes в «Проверке»'),
  'mech.badge': ('live on devnet', 'живьём на devnet'),

  'rules.h': ('Rules &amp; <span class="tag-accent">fairness</span>', 'Правила и <span class="tag-accent">честность</span>'),
  'rules.p': ('This section is deliberately boring and graffiti-free — it is about money, so precision matters more than mood.',
              'Этот раздел намеренно скучный и без граффити — он про деньги, поэтому точность важнее настроения.'),
  'rules.1': ("Randomness comes from Solana SlotHashes. The program hashes your committed seed with the slot hash, refuses a seed that is not from the current slot, and refuses to open a pack whose value was already visible — the studio's server never picks a result after seeing your payment.",
              'Случайность берётся из SlotHashes Solana. Программа хеширует зафиксированный сид с хешем слота, отвергает сид не из текущего слота и отказывается вскрывать пак, значение которого уже было видно, — сервер студии никогда не выбирает результат после вашей оплаты.'),
  'rules.2': ('Odds, floors, pity and prices live in one on-chain config. Changes go through a 2-of-5 multisig, emit an event with a version number and are validated against the invariants in the open economy package before signing.',
              'Шансы, флоры, pity и цены живут в одном on-chain-конфиге. Изменения проходят через мультисиг 2 из 5, публикуют событие с номером версии и проверяются на инварианты открытого пакета экономики до подписи.'),
  'rules.3': ('The marketplace fee is tunable between 0 and 10 % and can never exceed that ceiling; the 2.5 % royalty is a program constant and cannot be raised.',
              'Комиссия маркетплейса настраивается в пределах 0–10 % и никогда не может превысить этот потолок; роялти 2,5 % — константа программы и не может быть повышено.'),
  'rules.4': ('In Cap Slam only the $CG wager is at stake, held in escrow; the program can pay out to the challenger or the opponent and nobody else. Caps are never burned, transferred or locked by a fight.',
              'В Cap Slam на кону только ставка в $CG, лежащая в эскроу; программа может выплатить её претенденту или оппоненту и никому больше. Фишки никогда не сжигаются, не передаются и не блокируются боем.'),
  'rules.5': ('If a reveal never arrives you cancel and get refunded after 10 800 slots (about 72 minutes). If a pack is bought and the app crashes, the pending pack is visible on your Home screen until it is opened or refunded — our crank opens it for you.',
              'Если раскрытие так и не пришло, вы отменяете покупку и получаете возврат через 10 800 слотов (около 72 минут). Если пак куплен, а приложение упало, ожидающий пак виден на главном экране, пока не будет вскрыт или возвращён — наш crank вскроет его за вас.'),
  'rules.6': ('An emergency pause blocks new purchases, listings and stakes during an incident. It never freezes what you already own: unstake, cancel and withdraw keep working.',
              'Аварийная пауза блокирует новые покупки, листинги и стейки во время инцидента. Она никогда не замораживает то, чем вы уже владеете: анстейк, отмена и вывод продолжают работать.'),
  'rules.7': ('Every action emits an event. Our backend is a cache over those events, not a source of truth — anyone can re-index the four programs and get the same leaderboards.',
              'Каждое действие публикует событие. Наш бэкенд — кэш над этими событиями, а не источник истины: любой может переиндексировать четыре программы и получить те же лидерборды.'),
  'rules.disclaimer': ('GUTTERCAPS is a collectible game with chance-based mechanics that use real funds. Secondary-market cap value is not guaranteed and can drop to zero. $CG is intended for in-game use; its legal classification depends on the applicable law. No return is guaranteed and nothing here is financial advice. 18+ only. Availability may be restricted in some jurisdictions. Only play with funds you can afford to lose.',
                       'GUTTERCAPS — коллекционная игра с элементами случайности, в которой используются реальные средства. Стоимость фишек на вторичном рынке не гарантируется и может упасть до нуля. $CG предназначен для использования в игре; его правовая классификация зависит от применимого закона. Доходность не гарантируется; это не финансовый совет. Только 18+. В некоторых юрисдикциях доступ может быть ограничен. Играйте только на средства, которые можете позволить себе потерять.'),

  'road.h': ('Roadmap: <span class="tag-accent">layers of paint</span>', 'Роадмап: <span class="tag-accent">слои краски</span>'),
  'road.p': ('A mural gets painted in layers — primer, base colours, detail, clear coat. No fixed dates, a clear order, and a rule: nothing touches mainnet before an independent audit.',
             'Мурал пишут слоями — грунт, базовые цвета, детали, лак. Без жёстких дат, с понятным порядком и одним правилом: ничто не выходит в mainnet до независимого аудита.'),
  'road.s1': ('Now · devnet', 'Сейчас · devnet'), 'road.s2': ('Next', 'Дальше'), 'road.s3': ('Later', 'Позже'), 'road.s4': ('Beyond the horizon', 'За горизонтом'),
  'road.1h': ('Priming the wall', 'Грунтуем стену'),
  'road.1p': ('The core loop is playable end-to-end on devnet.', 'Основная петля целиком играется на devnet.'),
  'road.1a': ('Packs with SlotHashes, floors and pity · SOL / USDC / SKR / $CG', 'Паки с SlotHashes, флорами и pity · SOL / USDC / SKR / $CG'),
  'road.1b': ('3 → 1 fusion with boosters and result locks', 'Фьюжн 3 → 1 с бустерами и блокировкой результата'),
  'road.1c': ('Escrow market, cap & $CG staking, district set bonus', 'Эскроу-маркет, стейкинг фишек и $CG, бонус за сет района'),
  'road.1d': ('Provably-fair Verify page · app in 7 languages', 'Страница проверки честности · приложение на 7 языках'),
  'road.1e': ('Cap Slam 3-v-3 with escrowed $CG wagers', 'Cap Slam 3 на 3 со ставками $CG в эскроу'),
  'road.1f': ('Quests with Merkle claims, anti-farm caps, referrals', 'Квесты с Merkle-клеймами, антифарм-лимиты, рефералка'),
  'road.2h': ('Base colours', 'Базовые цвета'),
  'road.2p': ('The game stops being about opening packs and starts being about competing.', 'Игра перестаёт быть про вскрытие паков и становится про соревнование.'),
  'road.2a': ('Cap Slam leagues, ladders and six-week seasons', 'Лиги, рейтинги и шестинедельные сезоны Cap Slam'),
  'road.2b': ('Seasonal quest lines and event calendars', 'Сезонные линии квестов и календарь ивентов'),
  'road.2c': ('@handles, skins, themes, season pass', '@хэндлы, скины, темы, сезонный пропуск'),
  'road.2d': ('Solana dApp Store listing for Seeker', 'Публикация в Solana dApp Store для Seeker'),
  'road.3h': ('Detail &amp; shine', 'Детали и блеск'),
  'road.3p': ('The economy leaves the sandbox.', 'Экономика выходит из песочницы.'),
  'road.3a': ('Independent audit of all four programs → mainnet', 'Независимый аудит всех четырёх программ → mainnet'),
  'road.3b': ('Market price history and floor analytics', 'История цен и аналитика флоров'),
  'road.3c': ('Limited event packs and the first tournaments', 'Лимитированные ивент-паки и первые турниры'),
  'road.4h': ('Clear coat', 'Лак'),
  'road.4p': ('The economy starts belonging to players in more than cap ownership.', 'Экономика начинает принадлежать игрокам не только владением фишками.'),
  'road.4a': ('$CG holder votes on new districts and event themes', 'Голосование держателей $CG за новые районы и темы ивентов'),
  'road.4b': ('Guest walls: collab sets with independent street artists', 'Гостевые стены: коллаб-сеты с независимыми уличными художниками'),
  'road.4c': ('Public buyback & burn dashboard', 'Публичный дашборд выкупа и сжигания'),

  'faq.h': ('Questions people <span class="tag-accent">actually ask</span>', 'Вопросы, которые <span class="tag-accent">реально задают</span>'),
  'faq.p': ('Short answers. Long ones live in the docs.', 'Коротко. Длинно — в документации.'),

  'stats.h': ('Live from <span class="tag-accent">the chain</span>', 'Живьём <span class="tag-accent">из блокчейна</span>'),
  'stats.p': ("Numbers come from our open indexer over the programs' events — not from a marketing slide. While the game is on devnet they are devnet numbers.",
              'Числа приходят из нашего открытого индексатора событий программ, а не со слайда презентации. Пока игра на devnet — это числа devnet.'),
  'stats.1': ('caps alive', 'живых фишек'), 'stats.2': ('packs opened', 'вскрыто паков'), 'stats.3': ('wallets that opened a pack', 'кошельков, вскрывших пак'), 'stats.4': ('battles resolved', 'проведено боёв'),
  'stats.offline': ('Indexer offline — counters appear as soon as the devnet indexer is reachable.', 'Индексатор недоступен — счётчики появятся, как только devnet-индексатор будет в сети.'),
  'stats.source': ('source: GET /v1/stats', 'источник: GET /v1/stats'),

  'community.h': ('Find the <span class="tag-accent">crew</span>', 'Найти <span class="tag-accent">своих</span>'),
  'community.p': ('Drops, season schedules and audits are announced here first.', 'Дропы, расписание сезонов и аудиты объявляются здесь первыми.'),

  'foot.h': ('The wall is waiting for <span class="tag-accent">your tag</span>', 'Стена ждёт <span class="tag-accent">твой тег</span>'),
  'foot.p': ('Open the app, connect any Solana wallet — the Starter pack is $1.99 and opens right away.', 'Откройте игру, подключите любой Solana-кошелёк — стартовый пак стоит $1.99 и вскрывается сразу.'),
  'foot.cta': ('Open the app', 'Открыть игру'),
  'foot.fine': ('GUTTERCAPS © 2026. All characters, districts and names are fictional and original. Not affiliated with Solana Mobile; Seeker and SKR belong to their respective owners. Contract addresses and audits are listed in the docs — verify before you pay.',
                'GUTTERCAPS © 2026. Все персонажи, районы и названия вымышлены и оригинальны. Не аффилировано с Solana Mobile; Seeker и SKR принадлежат их владельцам. Адреса контрактов и аудиты перечислены в документации — проверяйте перед оплатой.'),
}

HOWTO = [
  {'color': 'var(--cyan-soft)', 'glow': 'rgba(22,229,217,0.35)',
   'en': ('Connect', 'Any Solana wallet — Phantom, Solflare, Backpack or the Seeker wallet. Sign-in is a signed message: no e-mail, no password, no custody.', 'sign-in with Solana'),
   'ru': ('Подключиться', 'Любой Solana-кошелёк — Phantom, Solflare, Backpack или кошелёк Seeker. Вход — подписанное сообщение: без e-mail, пароля и кастодиала.', 'вход через Solana')},
  {'color': 'var(--magenta-soft)', 'glow': 'rgba(255,46,138,0.35)',
   'en': ('Buy a pack', 'Starter $1.99 once, Standard $5.99, Premium $14.99, Limited $29.99. Pay in SOL, USDC or SKR (−5 %). The same transaction commits an on-chain SlotHashes seed.', 'payment + seed in one tx'),
   'ru': ('Купить пак', 'Starter $1.99 один раз, Standard $5.99, Premium $14.99, Limited $29.99. Оплата в SOL, USDC или SKR (−5 %). Та же транзакция фиксирует ончейн-сид SlotHashes.', 'оплата + сид в одной tx')},
  {'color': 'var(--acid-soft)', 'glow': 'rgba(182,255,60,0.35)',
   'en': ('Reveal', 'SlotHashes at that slot become 32 bytes the program expands into tiers and districts. The Verify page recomputes your roll from those bytes.', 'provably fair'),
   'ru': ('Вскрыть', 'SlotHashes того слота становятся 32 байтами, которые программа разворачивает в тиры и районы. Страница проверки пересчитывает ваш ролл из этих байтов.', 'доказуемо честно')},
  {'color': 'var(--orange-soft)', 'glow': 'rgba(255,122,26,0.35)',
   'en': ('Fuse 3 → 1', 'Three caps of one tier become one of the next. Same district on every second step. From Epic up it can fail and refunds one material; a booster adds +15 pp.', '8 recipes, Common → Diamond'),
   'ru': ('Слить 3 → 1', 'Три фишки одного тира становятся одной следующего. На каждом втором шаге — один район. С Epic может провалиться и вернуть один материал; бустер даёт +15 п.п.', '8 рецептов, Common → Diamond')},
  {'color': 'var(--trust-soft)', 'glow': 'rgba(46,139,255,0.35)',
   'en': ('Play the wall', 'Slam 3-v-3 for $CG wagers, list on the market, stake caps or $CG, clear quests, complete a district for a staking bonus.', 'arena · market · staking · quests'),
   'ru': ('Играть на стене', 'Бейтесь 3 на 3 на ставки в $CG, выставляйте на маркет, стейкайте фишки или $CG, закрывайте квесты, собирайте район ради бонуса к стейкингу.', 'арена · маркет · стейкинг · квесты')},
]

PACKS = [
  {'color': 'var(--chrome)', 'glow': 'rgba(216,216,220,0.35)', 'price': '$1.99', 'cg': None,
   'en': ('Starter', 'once per wallet', ['4 caps · floor Rare', 'Caps are soulbound for 7 days', 'No pity — it is a gift, not a grind', 'SOL · USDC · SKR']),
   'ru': ('Starter', 'один раз на кошелёк', ['4 фишки · флор Rare', 'Фишки soulbound 7 дней', 'Без pity — это подарок, а не гринд', 'SOL · USDC · SKR'])},
  {'color': 'var(--cyan-soft)', 'glow': 'rgba(22,229,217,0.35)', 'price': '$5.99', 'cg': '2 700 $CG',
   'en': ('Standard', 'the daily driver', ['4 caps · floor Common+', 'Legend guaranteed by pack 60', 'Soft pity from pack 30', 'SOL · USDC · SKR · $CG']),
   'ru': ('Standard', 'рабочая лошадка', ['4 фишки · флор Common+', 'Legend гарантирован к 60-му паку', 'Мягкий pity с 30-го пака', 'SOL · USDC · SKR · $CG'])},
  {'color': 'var(--magenta-soft)', 'glow': 'rgba(255,46,138,0.35)', 'price': '$14.99', 'cg': '6 750 $CG',
   'en': ('Premium', 'five at once', ['5 caps · floor Rare', 'Legend guaranteed by pack 40', 'Soft pity from pack 20', 'SOL · USDC · SKR · $CG']),
   'ru': ('Premium', 'пять за раз', ['5 фишек · флор Rare', 'Legend гарантирован к 40-му паку', 'Мягкий pity с 20-го пака', 'SOL · USDC · SKR · $CG'])},
  {'color': 'var(--orange-soft)', 'glow': 'rgba(255,122,26,0.35)', 'price': '$29.99', 'cg': None,
   'en': ('Limited', 'featured district only', ['5 caps · floor Rare+', 'Legend guaranteed by pack 25', 'Max 5 per wallet per day', 'SOL · USDC · SKR — funds the season pool']),
   'ru': ('Limited', 'только избранный район', ['5 фишек · флор Rare+', 'Legend гарантирован к 25-му паку', 'Не более 5 на кошелёк в день', 'SOL · USDC · SKR — питает призовой фонд сезона'])},
]

FAQ = [
  ('Is this gambling?', 'It is a collectible game with chance-based packs bought with real funds, so we treat it like one: 18+, odds and pity published in the program config, every roll verifiable, no cash-out promises. The market is peer-to-peer — the studio never buys caps back at a set price.',
   'Это азартная игра?', 'Это коллекционная игра с паками на основе случайности, купленными за реальные деньги, поэтому мы и относимся к ней так: 18+, шансы и pity опубликованы в конфиге программы, каждый ролл проверяем, никаких обещаний вывода. Маркет — peer-to-peer: студия никогда не выкупает фишки по фиксированной цене.'),
  ('What can I pay with?', 'SOL, USDC and SKR for everything; $CG for Standard and Premium packs (75 % of it is burned). SOL and SKR convert at a frozen studio rate (SOL = $110, SKR = $0.016).',
   'Чем можно платить?', 'SOL, USDC и SKR — за всё; $CG — за паки Standard и Premium (75 % сжигается). SOL и SKR пересчитываются по фиксированному курсу студии (SOL = $110, SKR = $0.016).'),
  ('What is SKR and do I need a Seeker phone?', 'SKR is the Solana Mobile Seeker ecosystem token. You do not need a Seeker: any Solana wallet works. Seeker owners get the 5 % SKR pack discount and the dApp Store install. The game only accepts the genuine SKR mint and never mints or burns SKR.',
   'Что такое SKR и нужен ли телефон Seeker?', 'SKR — токен экосистемы Solana Mobile Seeker. Seeker не нужен: подойдёт любой Solana-кошелёк. Владельцы Seeker получают скидку 5 % на паки в SKR и установку из dApp Store. Игра принимает только подлинный минт SKR и никогда его не выпускает и не сжигает.'),
  ('Can I lose my caps in Cap Slam?', 'No. Only the $CG wager is at stake, and it sits in escrow until the program settles the match. Caps are never burned, transferred or locked by a fight.',
   'Можно ли потерять фишки в Cap Slam?', 'Нет. На кону только ставка в $CG, и она лежит в эскроу, пока программа не рассчитает матч. Фишки никогда не сжигаются, не передаются и не блокируются боем.'),
  ('What if the reveal never comes?', 'Nothing is lost. SlotHashes land in seconds and our crank opens the pack even if you close the app. If the roll never completes, a pending pack stays visible on your Home screen; after 10 800 slots (≈ 72 min) you can cancel it and the payment is refunded by the program, not by support.',
   'Что, если раскрытие не придёт?', 'Ничего не теряется. SlotHashes появляются за секунды, а наш crank вскрывает пак, даже если вы закрыли приложение. Если ролл так и не завершится, ожидающий пак остаётся на главном экране; через 10 800 слотов (≈ 72 мин) вы можете его отменить, и программа — не поддержка — вернёт оплату.'),
  ('How do I check the odds are real?', 'Open any pack result and press Verify. You will see the randomness account, the 32 revealed bytes, your pity counter before and after, the effective odds at that moment and a local recomputation of the roll next to the on-chain event.',
   'Как проверить, что шансы настоящие?', 'Откройте результат любого пака и нажмите «Проверить». Вы увидите аккаунт случайности, 32 раскрытых байта, счётчик pity до и после, эффективные шансы на тот момент и локальный пересчёт ролла рядом с on-chain-событием.'),
  ('What does the studio earn?', 'A 7.5 % marketplace fee (⅓ of it buys back and burns $CG), a 2.5 % creator royalty, 5 % rake on wagers, pack sales in SOL / USDC / SKR, and cosmetic extras. Nothing we sell changes odds, power or yield.',
   'На чём зарабатывает студия?', 'Комиссия маркетплейса 7,5 % (⅓ из неё выкупает и сжигает $CG), роялти 2,5 %, рейк 5 % со ставок, продажа паков за SOL / USDC / SKR и косметические экстры. Ничто из продаваемого не меняет шансы, силу или доход.'),
  ('Which languages does the app speak?', 'English, Português, Español, Tiếng Việt, Bahasa Indonesia, Filipino and Русский. The language tab is the seventh tab in the app; numbers, dates and money are formatted per locale but never translated.',
   'На каких языках говорит приложение?', 'English, Português, Español, Tiếng Việt, Bahasa Indonesia, Filipino и Русский. Вкладка языка — седьмая в приложении; числа, даты и деньги форматируются по локали, но никогда не переводятся.'),
  ('When mainnet?', 'After an independent audit of all four programs — that is Layer 3 on the roadmap. Until then everything runs on devnet with test funds, and the counters on this page say so.',
   'Когда mainnet?', 'После независимого аудита всех четырёх программ — это третий слой роадмапа. До тех пор всё работает на devnet с тестовыми средствами, о чём и говорят счётчики на этой странице.'),
  ('Is the code open?', 'The four Anchor programs, the economy package with its invariant tests, the indexer and the app are in the repository linked below. The economy numbers on this page are rendered from that same package.',
   'Код открыт?', 'Четыре Anchor-программы, пакет экономики с тестами инвариантов, индексатор и приложение лежат в репозитории по ссылке ниже. Числа экономики на этой странице берутся из того же пакета.'),
  ('What is the pre-sale?', 'Two Limited Event Pack offers sold for mainnet SOL while the game runs its free devnet beta: 500 singles at 0.30 SOL (max 5 per wallet) and 125 founders chests of 4 packs at 0.999 SOL (max 1 per wallet). Payment goes to the team multisig (2-of-3) with a memo; packs are granted on-chain at mainnet launch in reservation order, and you open them yourself with the same on-chain SlotHashes as any purchase. The campaign can be switched off at any moment; the public reservation registry is the record for refunds.',
   'Что такое пре-сейл?', 'Два предложения Limited-паков за mainnet SOL, пока идёт бесплатная devnet-бета: 500 одиночных по 0,30 SOL (макс. 5 на кошелёк) и 125 сундуков основателей из 4 паков по 0,999 SOL (макс. 1 на кошелёк). Оплата уходит в мультиподпись команды (2-из-3) с мемо; паки выдаются на цепи при запуске майнета в порядке бронирования, и вскрываете вы их сами — с теми же ончейн-SlotHashes, что и любую покупку. Кампанию можно остановить в любой момент; публичный реестр бронирований — основание для возвратов.'),
]

# (key, colour, Standard-pack odds, base power, level cap, stake weight)
# Filled/verified from packages/economy by scripts/landing/check.py.
TIERS = [
  ('Common', '#9a9a9a', '45%', 100, 12, 1), ('Common+', '#8fae9c', '25%', 145, 16, 2), ('Rare', '#7fa8ad', '15%', 210, 20, 5),
  ('Rare+', '#7f93b0', '8%', 305, 24, 12), ('Epic', '#a97fa8', '4.5%', 440, 28, 30), ('Epic+', '#b98f6a', '1.8%', 640, 32, 80),
  ('Legend', '#c0946a', '0.5%', 930, 36, 220), ('Legend+', '#a3b97f', '0.18%', 1350, 40, 650), ('Diamond', '#c7c7cc', '0.02%', 2000, 50, 2200),
]

for _i, (_q, _a, _qr, _ar) in enumerate(FAQ):
    T[f'faq.q{_i}'] = (_q, _qr)
    T[f'faq.a{_i}'] = (_a, _ar)

SITE = 'https://guttercaps.gg'
TITLE = ('GUTTERCAPS — provably-fair street-art caps on Solana · fuse, slam, stake',
         'GUTTERCAPS — доказуемо честные стрит-арт фишки на Solana · фьюжн, арена, стейкинг')
DESC = ('GUTTERCAPS: 72 street-art bottle caps on Solana. Provably-fair packs (on-chain SlotHashes, on-chain pity), 3→1 fusion, Cap Slam 3-v-3 wagers, escrow market, $CG staking. Pay in SOL, USDC or SKR. Built for Seeker, in 7 languages.',
        'GUTTERCAPS: 72 стрит-арт крышек на Solana. Доказуемо честные паки (ончейн-SlotHashes, on-chain pity), фьюжн 3→1, ставки Cap Slam 3 на 3, эскроу-маркет, стейкинг $CG. Оплата в SOL, USDC или SKR. Для Seeker, на 7 языках.')
T['meta.title'] = TITLE
T['meta.desc'] = DESC

# Shared keys for dynamic and accessible text, not just static paragraphs.
for _i, _step in enumerate(HOWTO):
    for _j, _part in enumerate(('h', 'p', 'f')):
        T[f'how.{_i}.{_part}'] = (_step['en'][_j], _step['ru'][_j])
T.update({
    'pack.tag0': ('once per wallet', 'один раз на кошелёк'),
    'pack.tag1': ('the daily driver', 'на каждый день'),
    'pack.tag2': ('five at once', 'пять за раз'),
    'pack.tag3': ('featured district only', 'только избранный район'),
    'pack.caps': ('{n} caps · floor {rarity}', 'Фишек: {n} · минимум {rarity}'),
    'pack.lock': ('Transfer-locked for {days} days', 'Передача заблокирована на {days} дней'),
    'pack.noPity': ('No pity counter', 'Без счётчика гаранта'),
    'pack.hard': ('{rarity} guaranteed by pack {n}', '{rarity} гарантирована к паку {n}'),
    'pack.soft': ('Soft pity from pack {n}', 'Шансы растут с пака {n}'),
    'pack.limit': ('Max {n} per wallet per day', 'Не более {n} на кошелёк в день'),
    'pack.pool': ('SOL · USDC · SKR — funds the season pool', 'SOL · USDC · SKR — пополняет призовой фонд сезона'),
    'pack.or': ('or {amount}', 'или {amount}'),
    'level': ('Lv {n}', 'Ур. {n}'),
    'stats.slot': ('devnet · slot {n}', 'devnet · слот {n}'),
    'footer.terms': ('Terms', 'Условия'),
    'footer.privacy': ('Privacy', 'Конфиденциальность'),
    'nav.language': ('Language', 'Язык'),
    'community.docs': ('Documentation', 'Документация'),
    'allocation.label': ('$CG: 55% play, 15% ecosystem, 15% team, 10% treasury, 5% airdrops', '$CG: 55% игра, 15% экосистема, 15% команда, 10% казна, 5% эйрдропы'),
    'allocation.cap': ('hard cap', 'жёсткий лимит'),
    'allocation.billion': ('1 billion', '1 миллиард'),
    'skr.mint': ('SKR mint', 'Mint SKR'),
    'skr.decimals': ('6 decimals', '6 знаков после запятой'),
})

# Correct factual ambiguities before translating them. Offers settle in USDC;
# market listings freeze the cap in place; the SKR discount is not phone-gated.
T['rules.2'] = (
    'Odds, floors, pity and prices live in one on-chain config. Changes require the responsible multisig, emit a versioned event and are validated against the open economy package invariants before signing.',
    'Шансы, минимальная редкость, гарант и цены хранятся в единой конфигурации в блокчейне. Изменения требуют подписи уполномоченного мультисига, выпускают событие с номером версии и перед подписанием проверяются по инвариантам открытого пакета экономики.',
)
T['mech.4p'] = (
    'List in SOL, USDC or SKR; the cap stays frozen in your wallet until sold or cancelled, and payment goes directly to you. Offers in USDC. Floors per district × tier are tracked live; minimum prices stop dust listings.',
    'Выставляйте за SOL, USDC или SKR: фишка заморожена в вашем кошельке до продажи или отмены, а оплата идёт напрямую вам. Предложения покупки — в USDC. Минимальные цены отслеживаются по району и редкости; нижний порог защищает от пылевых объявлений.',
)
T['eco.skr.p'] = (
    'Packs, market sales and extras accept SKR; offers use USDC. SKR converts at the frozen studio rate ($0.016). Only the genuine mint below is accepted, never a symbol lookup. The game cannot mint SKR: its prize pool is funded weekly from the public treasury with 15 % of SKR pack revenue, 10 % of SKR market fees and 5 % of SKR extras. Seeker quests, seasons and tournaments use Merkle claims capped per wallet. Wagers, fusion and staking stay in $CG.',
    'Паки, продажи на маркете и дополнения принимают SKR; предложения покупки — в USDC. SKR пересчитывается по фиксированному курсу студии ($0.016). Принимается только подлинный mint ниже, а не совпадение символа. Игра не выпускает SKR: призовой пул пополняется еженедельно из публичной казны — 15 % выручки паков SKR, 10 % комиссий маркета SKR и 5 % дополнений SKR. Квесты Seeker, сезоны и турниры используют Merkle-выплаты с лимитом на кошелёк. Ставки, слияние и стейкинг остаются в $CG.',
)
T['faq.a1'] = (
    'SOL, USDC and SKR for packs and extras; market sales in those three currencies, offers in USDC. $CG buys Standard and Premium packs (75 % burned). SOL and SKR convert at a frozen studio rate (SOL = $110, SKR = $0.016).',
    'SOL, USDC и SKR — для паков и дополнений; продажи на маркете — в этих трёх валютах, предложения покупки — в USDC. $CG оплачивает обычные и премиум-паки (75 % сжигается). SOL и SKR пересчитываются по фиксированному курсу студии (SOL = $110, SKR = $0.016).',
)
T['faq.a2'] = (
    'SKR is the Solana Mobile Seeker ecosystem token. Any Solana wallet works; no Seeker phone is required. Packs paid in SKR get a 5 % discount; Seeker supports installation through the dApp Store. Only the genuine SKR mint is accepted; the game never mints or burns SKR.',
    'SKR — токен экосистемы Solana Mobile Seeker. Подойдёт любой Solana-кошелёк, телефон Seeker не обязателен. Паки за SKR дешевле на 5 %; на Seeker доступна установка через dApp Store. Принимается только подлинный mint SKR; игра не выпускает и не сжигает SKR.',
)
for _i, (_q, _a, _qr, _ar) in enumerate(FAQ):
    FAQ[_i] = (T[f'faq.q{_i}'][0], T[f'faq.a{_i}'][0], T[f'faq.q{_i}'][1], T[f'faq.a{_i}'][1])
T.update({
    'skr.treasury': ('Treasury (SKR)', 'Казна (SKR)'),
    'skr.funding': ('Funds the prize pool weekly · ledger:', 'Пополняет призовой пул еженедельно · реестр:'),
})
# Rendering metadata is language-independent and checked against economy by check.ts.
for _p, _m in zip(PACKS, [
    {'chips': 4, 'floor': 2, 'hardAt': None, 'softStart': None, 'dailyCap': 1, 'art': 'starter'},
    {'chips': 4, 'floor': 1, 'hardAt': 60, 'softStart': 30, 'dailyCap': None, 'art': 'standard'},
    {'chips': 5, 'floor': 2, 'hardAt': 40, 'softStart': 20, 'dailyCap': None, 'art': 'premium'},
    {'chips': 5, 'floor': 3, 'hardAt': 25, 'softStart': 12, 'dailyCap': 5, 'art': 'limited'},
]):
    _p.update(_m)
# WHY block (2026-10 reorg): the loop and its value, second after the hero,
# before the economy deep-dive — keeps the phone scroll on live information.
T.update({
  'nav.why': ('Why it pays', 'Почему выгодно'),
  'why.h': ('The loop, and why it pays', 'Цикл игры — и почему это выгодно'),
  'why.p': ('Guttercaps is a cap-battle economy: open packs, upgrade caps, fight for $CG. Every step either protects or grows what you paid for — here is the whole loop in four moves.',
            'Guttercaps — это экономика боёв на фишках: открываешь паки, прокачиваешь фишки, бьёшься за $CG. Каждый шаг либо защищает, либо растит то, за что ты заплатил, — вот весь цикл в четырёх ходах.'),
  'why.l1': ('Pack: a floor rarity and pity — your money always turns into real value',
             'Пак: флор-редкость и pity — деньги всегда превращаются в реальную ценность'),
  'why.l2': ('Caps: eight districts, nine tiers — rarer caps hit harder',
             'Фишки: восемь районов, девять тиров — редкие бьют сильнее'),
  'why.l3': ('Fuse & fight: merge caps into a higher tier, win $CG in Cap Slam',
             'Фьюжн и бои: сливай фишки в тир выше, выигрывай $CG в Cap Slam'),
  'why.l4': ('Earn back: the market, staking and quests put $CG back in your pocket',
             'Возврат: маркет, стейкинг и квесты возвращают $CG в карман'),
  'why.v1h': ('Your spend is guarded', 'Твоя трата защищена'),
  'why.v1p': ('Every pack has a floor rarity and a published pity counter. No dud packs: worst case you still get a cap at the floor, and a Legend is guaranteed by a known pack number.',
              'У каждого пака есть флор-редкость и публичный счётчик pity. Пустых паков не бывает: в худшем случае выпадает фишка флора, а Legend гарантирован к известному номеру пака.'),
  'why.v2h': ('Upgrade without gambling twice', 'Апгрейд без второй ставки на удачу'),
  'why.v2p': ('Fusion merges three caps into one of a higher tier for free. Cheap Commons become Epics without buying more packs.',
              'Фьюжн бесплатно объединяет три фишки в одну тиром выше. Дешёвые Common становятся Epic без покупки новых паков.'),
  'why.v3h': ('Caps earn, they do not sit', 'Фишки работают, а не лежат'),
  'why.v3p': ('Cap Slam battles pay $CG to the winner, the market lets you sell what you pull, and staking plus quests drip rewards while you are away.',
              'Бои в Cap Slam платят победителю $CG, маркет позволяет продать дроп, а стейкинг и квесты капают наградами, пока тебя нет.'),
  'why.v4h': ('The prize pool is real money', 'Призовой фонд — реальные деньги'),
  'why.v4p': ('Every Limited Event Pack funds the season pool, and the SKR treasury tops it up weekly. The ledger is public and on-chain.',
              'Каждый Limited Event Pack питает фонд сезона, а казна SKR пополняет его еженедельно. Реестр публичный и он-чейн.'),
})

T['faq.a4'] = (
    'The background worker can open the pack even while the app is closed. If the roll does not complete, the pending pack stays on your Home screen. After 10 800 slots (about 72 minutes), you can cancel; the program refunds the payment, without relying on support.',
    'Фоновый обработчик может открыть пак, даже когда приложение закрыто. Если ролл не завершится, незавершённый пак остаётся на главной странице. После 10 800 слотов (около 72 минут) его можно отменить; программа вернёт оплату без обращения в поддержку.',
)
T['faq.a7'] = (
    'English, Português, Español, Tiếng Việt, Bahasa Indonesia, Filipino and Русский. Choose your language in the app; numbers, dates and amounts follow local formatting without changing token values.',
    'English, Português, Español, Tiếng Việt, Bahasa Indonesia, Filipino и Русский. Выберите язык в приложении: числа, даты и суммы получат местный формат, но значения токенов не изменятся.',
)
T['foot.p'] = (
    'Open the app and connect a Solana wallet. The Starter pack costs $1.99; opening begins after purchase.',
    'Откройте приложение и подключите Solana-кошелёк. Стартовый пак стоит $1.99; открытие начинается после покупки.',
)
for _i, (_q, _a, _qr, _ar) in enumerate(FAQ):
    FAQ[_i] = (T[f'faq.q{_i}'][0], T[f'faq.a{_i}'][0], T[f'faq.q{_i}'][1], T[f'faq.a{_i}'][1])
