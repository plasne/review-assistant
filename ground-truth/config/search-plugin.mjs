const documents = [
  {
    id: 'fury-of-dracula-4e-scope',
    title: 'Fury of Dracula 4th Edition rules reference scope',
    url: 'fury-of-dracula-4e://rules/reference-scope',
    content: [
      'This knowledge base is an original, non-verbatim rules reference for Fury of Dracula 4th Edition.',
      'It is intended for search, review, and rules-question support, not as a substitute for the official rulebook, player aids, card text, or component diagrams.',
      'When exact wording, illustrated examples, setup diagrams, or card-specific exceptions matter, use the official game materials as the authority.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'scope', 'rules-reference']
  },
  {
    id: 'fury-of-dracula-4e-objective',
    title: 'Objective, sides, and victory conditions',
    url: 'fury-of-dracula-4e://rules/objective',
    content: [
      'Fury of Dracula is a hidden-movement game between Dracula and the hunters.',
      'One player controls Dracula and secretly travels through Europe while spreading influence and leaving encounters.',
      'The other players control hunters who share information, collect supplies, follow clues, reveal the trail, and try to destroy Dracula.',
      'The hunters win when Dracula is defeated by reducing his damage capacity through combat and card effects.',
      'Dracula wins when the influence track reaches its victory space, most commonly by maturing vampires, defeating or biting hunters, and resolving encounter or card effects that add influence.',
      'The game is asymmetric: the hunters act openly and coordinate as a team, while Dracula acts secretly and only reveals information when rules or effects require it.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'objective', 'victory', 'influence', 'hunters', 'dracula']
  },
  {
    id: 'fury-of-dracula-4e-components-map',
    title: 'Map, spaces, routes, and public information',
    url: 'fury-of-dracula-4e://rules/map-and-components',
    content: [
      'The map is divided into city spaces and sea zones connected by road, rail, and sea routes.',
      'Hunters occupy spaces openly on the board.',
      'Dracula tracks his current location secretly with location cards on his trail unless he is revealed.',
      'City sizes, ports, hospital locations, castles, and route types matter because they control movement choices, supply results, healing, and special effects.',
      'Road routes allow normal land movement.',
      'Rail routes require train tickets for hunters and are not available to Dracula.',
      'Sea routes connect ports and sea zones; sea travel is risky and can damage hunters or Dracula.',
      'Open information includes hunter locations, faceup cards, revealed trail cards, the time track, the influence track, defeated or discarded cards when visible, and any tokens placed openly by effects.',
      'Hidden information includes Dracula location cards that remain facedown, Dracula encounter choices, hidden cards in hands, and unrevealed trail information.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'map', 'routes', 'road', 'rail', 'sea', 'information']
  },
  {
    id: 'fury-of-dracula-4e-setup',
    title: 'Setup and starting state',
    url: 'fury-of-dracula-4e://rules/setup',
    content: [
      'At setup, assign one player to Dracula and assign the hunter characters among the remaining players.',
      'Place hunters in their printed starting locations, prepare the map, time track, influence track, train tickets, damage tokens, status tokens, item deck, event deck, encounter deck, combat cards, reference cards, and Dracula location deck.',
      'Dracula chooses a legal starting city in secret and places the matching location card on the first space of the trail.',
      'Dracula cannot start at sea and must follow any setup restrictions printed in the edition materials.',
      'Hunters receive their starting hands and resources as instructed by their character sheets and setup rules.',
      'Decks are shuffled and placed within reach; discard piles, the trail, and revealed information should be kept distinct so players can determine what is public and what remains hidden.',
      'After setup, play begins with the hunter side and proceeds through the normal time and round structure.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'setup', 'starting-location', 'components']
  },
  {
    id: 'fury-of-dracula-4e-round-structure',
    title: 'Round structure, time, day, and night',
    url: 'fury-of-dracula-4e://rules/round-structure',
    content: [
      'Play advances through repeated rounds governed by the time track.',
      'Hunters act during day and night portions of the round, normally taking one action per hunter during the day and one action per hunter during the night.',
      'After the hunters complete their actions for the current time period, the game advances according to the time track and Dracula takes his phase at the required point in the sequence.',
      'The time of day changes how some actions work, especially supply, combat choices, Dracula card effects, event timing, and special restrictions.',
      'Day effects and night effects are not interchangeable; when a card or rule names a time, resolve it only in that timing window.',
      'If multiple effects would resolve at the same timing point, resolve mandatory effects before optional effects unless the official priority text says otherwise, and let the appropriate side choose among simultaneous effects it controls.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'round', 'time', 'day', 'night', 'phase', 'timing']
  },
  {
    id: 'fury-of-dracula-4e-hunter-turn-actions',
    title: 'Hunter turns and standard actions',
    url: 'fury-of-dracula-4e://rules/hunter-actions',
    content: [
      'On a hunter action, the active hunter chooses one legal action and resolves it fully before the next hunter acts.',
      'Core hunter actions include move, supply, reserve a ticket, trade, rest, search, and character or card actions.',
      'A hunter must be in a legal space and satisfy timing restrictions for the chosen action.',
      'A hunter in a space with Dracula or with unresolved encounter threats may be prevented from taking peaceful actions such as resting, trading, or supplying until the threat is resolved.',
      'Card text can add actions, replace actions, restrict actions, or create exceptions.',
      'Hunters coordinate openly, may discuss deductions and plans, and may share public information, but they still resolve their own actions with their own resources.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'hunters', 'actions', 'turns']
  },
  {
    id: 'fury-of-dracula-4e-hunter-movement',
    title: 'Hunter movement by road, rail, and sea',
    url: 'fury-of-dracula-4e://rules/hunter-movement',
    content: [
      'A hunter move action changes the hunter location by road, rail, or sea.',
      'Road movement moves along one connected road route to an adjacent city.',
      'Rail movement requires spending a train ticket and following the ticket result to determine how far the hunter may travel along connected rail routes; rail is useful for long repositioning but depends on tickets and legal rail connections.',
      'A hunter can reserve a ticket as a separate action by drawing ticket options and keeping a legal ticket according to the rules.',
      'Sea movement lets a hunter move between a port and an adjacent sea zone, or between connected sea zones, and usually causes damage or risk because hunters are vulnerable while traveling by sea.',
      'Hunters at sea have limited action options and often must keep moving until they return to land.',
      'Movement can trigger encounters, reveal information, or force combat if the hunter enters Dracula location or a space containing an encounter token.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'hunters', 'movement', 'road', 'rail', 'tickets', 'sea']
  },
  {
    id: 'fury-of-dracula-4e-supply-items-events',
    title: 'Supply, item cards, and event cards',
    url: 'fury-of-dracula-4e://rules/supply-items-events',
    content: [
      'The supply action represents hunters gathering equipment, weapons, allies, information, and events.',
      'Supply depends on the hunter location and time of day.',
      'During the day, hunters in cities usually draw from item resources, with large cities providing better selection than smaller cities.',
      'At night, supply usually interacts with the event deck instead of ordinary item gathering, and some event draws may benefit Dracula depending on the card back, icon, or rule instruction.',
      'Item cards are generally hunter equipment such as weapons, defenses, travel help, or tools used in combat and investigation.',
      'Event cards are timing-sensitive effects that may be kept or resolved according to their text and ownership rules.',
      'Hand limits, card-type restrictions, and discard instructions are enforced whenever a hunter draws, keeps, trades, uses, or loses cards.',
      'If a card conflicts with a general rule, follow the card for that specific situation unless another rule explicitly overrides it.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'supply', 'items', 'events', 'cards', 'day', 'night']
  },
  {
    id: 'fury-of-dracula-4e-trade-rest-search',
    title: 'Trade, rest, search, and hunter support actions',
    url: 'fury-of-dracula-4e://rules/trade-rest-search',
    content: [
      'Trade allows hunters in the same city to exchange allowed item and event cards, helping the group concentrate weapons, defenses, and travel support where needed.',
      'Trade cannot be used unless both hunters are in a legal shared location and no rule or threat prevents the exchange.',
      'Rest lets a hunter recover damage, with better healing at hospitals or through card effects when applicable.',
      'Rest is generally unavailable when immediate danger is present, such as Dracula or certain unresolved encounters.',
      'Search is used when a hunter is at a location that may contain Dracula encounter cards or trail evidence.',
      'Searching reveals and resolves facedown encounter cards at the hunter location as instructed, often forcing a fight, a test, a penalty, or removal of the encounter.',
      'Search is central to clearing Dracula trail before encounters mature and to confirming where Dracula has been.',
      'Character abilities and card actions can provide additional support actions, movement, healing, investigation, or combat preparation.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'trade', 'rest', 'search', 'healing', 'encounters']
  },
  {
    id: 'fury-of-dracula-4e-dracula-phase',
    title: 'Dracula phase overview',
    url: 'fury-of-dracula-4e://rules/dracula-phase',
    content: [
      'During the Dracula phase, Dracula secretly advances his plan by moving, maintaining the trail, placing encounters, resolving mature effects, and applying phase-specific card effects.',
      'Dracula normally chooses a legal destination connected to his current location and places the corresponding location card facedown on the newest trail space.',
      'Existing trail cards slide along the trail, preserving Dracula recent route unless a power or effect changes it.',
      'After moving to a city, Dracula usually places an encounter card on that location card.',
      'Dracula does not place encounters at sea unless a specific effect says otherwise.',
      'If a hunter is in Dracula new location or Dracula enters a hunter location, Dracula can become revealed and combat may occur according to timing rules.',
      'Dracula should maintain hidden information carefully while still revealing cards, tokens, and effects whenever the rules require.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'dracula', 'phase', 'movement', 'trail', 'encounters']
  },
  {
    id: 'fury-of-dracula-4e-trail-hideouts',
    title: 'Dracula trail, hideouts, lairs, and revealing locations',
    url: 'fury-of-dracula-4e://rules/trail',
    content: [
      'The trail records Dracula recent movement using location cards and power cards.',
      'The newest position is added to the front of the trail and older cards slide toward the end.',
      'Cards on the trail are hidden until revealed by hunter movement, search, card effects, or Dracula being found.',
      'Each city location on the trail may hold an encounter card, creating a hideout.',
      'When a trail card advances far enough or is moved by an effect, it can become a lair or leave the trail depending on the edition procedure and card text.',
      'When an encounter matures, Dracula resolves the mature effect printed on that encounter, which is one of his main ways to gain influence.',
      'If a hunter enters a city on the trail, Dracula must reveal whether the location matches the hunter position when the rules call for it.',
      'If Dracula current location is revealed, keep it public until he legally moves or an effect hides him again.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'trail', 'hideout', 'lair', 'reveal', 'mature', 'locations']
  },
  {
    id: 'fury-of-dracula-4e-dracula-movement-restrictions',
    title: 'Dracula movement restrictions and sea travel',
    url: 'fury-of-dracula-4e://rules/dracula-movement-restrictions',
    content: [
      'Dracula movement is more restricted than hunter movement.',
      'He moves by road and sea but does not use rail.',
      'He cannot normally move to a location already present on his trail because that would contradict the hidden route, unless a power card or effect permits it.',
      'He cannot choose illegal destinations, forbidden spaces, or moves blocked by current effects.',
      'Sea travel helps Dracula escape but costs blood: entering a sea zone and continuing through sea zones damages Dracula according to the sea movement rules.',
      'Returning from sea to a port places Dracula back on land and may help hunters narrow his location because sea cards and ports constrain his route.',
      'Castle Dracula and certain powers can restore Dracula health, but these choices also create deduction clues.',
      'If Dracula has no legal move, follow the official forced-resolution procedure for illegal or impossible movement.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'dracula', 'movement', 'restrictions', 'sea', 'castle-dracula']
  },
  {
    id: 'fury-of-dracula-4e-dracula-powers',
    title: 'Dracula power cards and special movement choices',
    url: 'fury-of-dracula-4e://rules/dracula-powers',
    content: [
      'Dracula power cards let him bend the normal movement and trail rules.',
      'Hide represents remaining in the current city while adding a hidden trail entry and placing another encounter if legal.',
      'Wolf Form represents a fast land move across connected roads at a health cost or exposure cost defined by the card.',
      'Feed lets Dracula recover health instead of making ordinary progress, subject to timing and trail restrictions.',
      'Dark Call lets Dracula gain encounter options at a health cost and is useful when he needs better threats for the trail.',
      'Misdirect changes or removes trail information as instructed by the card, helping Dracula break deductions.',
      'Power cards are constrained by their text, by whether they are already on the trail, and by repeat-use restrictions.',
      'A power card on the trail gives hunters deduction information even while it protects Dracula exact location.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'dracula', 'powers', 'hide', 'wolf-form', 'feed', 'dark-call', 'misdirect']
  },
  {
    id: 'fury-of-dracula-4e-encounters',
    title: 'Encounter cards, ambushes, and mature effects',
    url: 'fury-of-dracula-4e://rules/encounters',
    content: [
      'Encounter cards are Dracula hidden threats placed on city locations in the trail.',
      'They can represent vampires, traps, spies, animals, servants, or supernatural hazards.',
      'When a hunter discovers or searches a location with an encounter, the encounter is revealed and resolved according to its text.',
      'Some encounters attack immediately, some create lingering penalties, some move or hide information, and some are defeated by combat or hunter effects.',
      'If an encounter remains unresolved long enough to mature, Dracula resolves its mature effect instead of the hunter-facing effect.',
      'New vampires and related encounters are especially important because mature vampire effects can add influence.',
      'Faceup encounters remain public and continue to affect hunters as instructed until discarded, defeated, or otherwise removed.',
      'Encounter timing matters: resolve reveal, ambush, combat, defeat, discard, and mature text in the order specified by the card and rules.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'encounters', 'ambush', 'mature', 'vampires', 'influence']
  },
  {
    id: 'fury-of-dracula-4e-combat-overview',
    title: 'Combat overview and combat rounds',
    url: 'fury-of-dracula-4e://rules/combat-overview',
    content: [
      'Combat occurs when a hunter confronts Dracula or certain encounters and enemies.',
      'Combat is resolved in rounds.',
      'Each side selects a legal combat card or item option, reveals choices, compares icons and text, and resolves the matching effects.',
      'Hunter combat options come from basic combat cards, item weapons, event effects, character abilities, and status limits.',
      'Dracula combat options depend on whether it is day or night, his combat cards, current form, status, and card effects.',
      'Damage, bites, escapes, item loss, prevention, and special effects are applied as instructed.',
      'Combat continues until an effect ends it, a participant escapes, an enemy is defeated, Dracula is no longer present, or the rules specify the combat stops.',
      'Because combat choices are simultaneous and icon-based, players should verify legal cards, timing, and cancellation before assigning damage.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'combat', 'damage', 'weapons', 'escape', 'icons']
  },
  {
    id: 'fury-of-dracula-4e-combat-dracula',
    title: 'Combat against Dracula',
    url: 'fury-of-dracula-4e://rules/combat-against-dracula',
    content: [
      'When a hunter encounters Dracula, Dracula is revealed and a Dracula combat begins.',
      'The time of day is critical because Dracula is much more dangerous at night and has different legal combat options.',
      'Hunters try to deal damage, prevent Dracula escape, and survive bite or defeat effects.',
      'Dracula tries to damage hunters, bite them, force despair, escape, or stall until a better time.',
      'Multiple hunters in the same location can participate according to the group combat rules, improving hunter odds but still requiring legal card choices from the active combatants.',
      'If Dracula takes enough damage to reach his defeat threshold, the hunters win immediately unless an effect prevents that result.',
      'If Dracula escapes or the combat ends without his defeat, update revealed status, location information, damage, bites, and any aftermath effects before play continues.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'combat', 'dracula', 'revealed', 'night', 'day', 'escape']
  },
  {
    id: 'fury-of-dracula-4e-damage-health-defeat',
    title: 'Damage, health, hunter defeat, and Dracula defeat',
    url: 'fury-of-dracula-4e://rules/damage-health-defeat',
    content: [
      'Damage tracks how close a character is to defeat.',
      'Hunters suffer damage from combat, sea travel, events, encounters, and Dracula effects.',
      'Hunters recover damage through rest, hospitals, items, events, character abilities, and other healing effects.',
      'When a hunter is defeated, resolve the defeat procedure: Dracula gains the appropriate benefit, the hunter is removed or delayed as instructed, then returns under the game rules rather than being permanently eliminated in ordinary play.',
      'Dracula suffers damage from hunter attacks, sea travel, some powers, events, and special effects.',
      'Dracula recovers through Castle Dracula, Feed, cards, and other listed effects.',
      'If Dracula reaches his defeat threshold, the hunter side wins.',
      'Always apply prevention, resistance, timing, and card text before checking final defeat results.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'damage', 'health', 'defeat', 'healing', 'hunters', 'dracula']
  },
  {
    id: 'fury-of-dracula-4e-bites-despair-status',
    title: 'Bites, despair, and status effects',
    url: 'fury-of-dracula-4e://rules/status-effects',
    content: [
      'Status effects mark long-term consequences on hunters.',
      'A bitten hunter has been wounded by Dracula or a vampire and carries a bite token or similar marker.',
      'Bites can restrict cards, worsen future outcomes, and bring the hunter closer to defeat or Dracula influence gains depending on character and effect text.',
      'Mina has special bite-related rules and must be handled according to her character instructions.',
      'Despair represents mental or supernatural pressure and can restrict trading, healing, combat, or event use as defined by the status rules.',
      'Other conditions and tokens can come from encounters, events, combat, and character abilities.',
      'Remove statuses only when a rule, location, card, or effect explicitly permits it.',
      'When a status changes what a hunter may do, check the status before choosing actions, combat cards, trades, or healing.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'status', 'bite', 'bitten', 'despair', 'mina', 'hunters']
  },
  {
    id: 'fury-of-dracula-4e-influence',
    title: 'Influence track and Dracula scoring',
    url: 'fury-of-dracula-4e://rules/influence',
    content: [
      'Influence measures Dracula progress toward victory.',
      'The influence marker advances when rules, events, encounters, matured vampires, hunter defeat, bite effects, or Dracula powers instruct it to advance.',
      'The most important planned source of influence is allowing vampire encounters to mature before hunters find and defeat them.',
      'Dracula can also gain influence through combat outcomes and card effects.',
      'Hunters slow the influence plan by searching the trail, clearing encounters, forcing Dracula to flee by sea, damaging him, and interrupting vampire maturation.',
      'If the influence marker reaches the victory space, Dracula wins immediately unless the triggering effect says to finish another step first.',
      'Because influence pressure is public, hunters can judge when to take risks against Dracula versus when to clear encounters.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'influence', 'victory', 'vampires', 'mature', 'scoring']
  },
  {
    id: 'fury-of-dracula-4e-deduction',
    title: 'Deduction, revealing Dracula, and hidden information discipline',
    url: 'fury-of-dracula-4e://rules/deduction-hidden-information',
    content: [
      'The hunter side wins by turning partial information into a route deduction.',
      'Useful clues include revealed trail cities, power cards on the trail, sea cards, known route restrictions, encounter locations, card effects, Dracula damage from sea or powers, and where Dracula could legally move next.',
      'When a hunter enters a possible trail city, Dracula must answer and reveal information exactly as required by the rules.',
      'If Dracula is revealed, his current location becomes public and hunters can converge for combat.',
      'Dracula should avoid giving extra hints beyond required reveals, but must not conceal mandatory public information.',
      'Hunters may record notes, compare possible routes, and eliminate impossible paths using movement restrictions and timing.',
      'Good Dracula play balances influence generation against route safety; good hunter play balances pursuit, supplies, healing, and encounter control.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'deduction', 'hidden-information', 'reveal', 'trail', 'strategy']
  },
  {
    id: 'fury-of-dracula-4e-card-timing-limits',
    title: 'Card timing, limits, and conflicts',
    url: 'fury-of-dracula-4e://rules/card-timing-limits',
    content: [
      'Cards are resolved according to their timing windows, ownership, and prerequisites.',
      'A card that says when it can be played cannot be used outside that window.',
      'A card that modifies movement, combat, damage, healing, searching, supply, or influence applies only to the specified target and duration.',
      'If multiple cards modify the same value or event, apply prevention and cancellation before final totals, then check defeat or victory after all relevant modifiers resolve.',
      'Hand limits and item limits are checked when drawing, keeping, trading, and ending effects as instructed.',
      'If the event deck or another deck creates different outcomes based on card backs or icons, resolve the ownership or recipient rule before reading the effect.',
      'Specific card text overrides general rules for that card, but it does not create a general precedent for unrelated situations.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'cards', 'timing', 'limits', 'events', 'items', 'conflicts']
  },
  {
    id: 'fury-of-dracula-4e-common-edge-cases',
    title: 'Common edge cases and rule checks',
    url: 'fury-of-dracula-4e://rules/edge-cases',
    content: [
      'Before resolving a disputed situation, identify the current phase, time of day, active character, location type, route type, revealed status, and relevant card text.',
      'For movement disputes, check whether the route exists, whether the moving side is allowed to use that route, whether tickets or sea rules apply, and whether the destination is legal.',
      'For trail disputes, check whether the location or power is already on the trail, whether Dracula is revealed, whether a card must be revealed, and whether an encounter should mature.',
      'For combat disputes, check legal combat cards, time of day, participant status, cancellation, damage prevention, escape effects, and aftermath triggers.',
      'For supply disputes, check city size, day or night timing, deck ownership, card backs, hand limits, and whether threats prevent the action.',
      'For status disputes, apply bite, despair, defeat, and healing restrictions before allowing the affected action.',
      'When a card and a general rule appear to conflict, follow the specific card for that exact case and leave unrelated rules unchanged.'
    ].join(' '),
    tags: ['fury-of-dracula', '4e', 'edge-cases', 'rules-checks', 'movement', 'combat', 'supply', 'trail']
  }
];

const searchKnowledgeBase = {
  name: 'searchKnowledgeBase',
  description:
    'Search the indexed knowledge base for source passages and structured references relevant to the user request.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language search query.' },
      topK: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum number of ranked results to return.' },
      filters: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional metadata filters, such as tags.'
      }
    },
    required: ['query'],
    additionalProperties: false
  },
  execute: async (request) => {
    const query = request.arguments.query;
    const topK = request.arguments.topK ?? 3;
    if (typeof query !== 'string' || query.trim() === '') {
      return toolError(request.requestId, 'query must be a non-empty string.');
    }
    if (!Number.isInteger(topK) || topK <= 0 || topK > 10) {
      return toolError(request.requestId, 'topK must be an integer between 1 and 10.');
    }

    const requestedTags = Array.isArray(request.arguments.filters?.tags)
      ? request.arguments.filters.tags.filter((tag) => typeof tag === 'string')
      : [];
    const terms = buildSearchTerms(query);
    const results = documents
      .filter((document) => requestedTags.every((tag) => document.tags.includes(tag)))
      .map((document) => ({ document, score: scoreDocument(document, terms) }))
      .filter((entry) => entry.score > 0 || terms.primary.length === 0)
      .sort((left, right) => right.score - left.score || left.document.title.localeCompare(right.document.title))
      .slice(0, topK)
      .map(({ document, score }) => ({
        id: document.id,
        title: document.title,
        url: document.url,
        excerpt: document.content,
        score,
        tags: document.tags
      }));

    return {
      requestId: request.requestId,
      ok: true,
      result: { query, results }
    };
  }
};

const stopWords = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'be',
  'can',
  'do',
  'does',
  'for',
  'from',
  'happen',
  'happens',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'then',
  'to',
  'what',
  'when',
  'where',
  'who',
  'why',
  'with'
]);

const searchAliases = new Map([
  ['heal', ['rest', 'recover', 'hospital', 'health', 'damage', 'healing']],
  ['move', ['movement', 'road', 'rail', 'sea', 'travel']],
  ['matur', ['mature', 'matures', 'matured', 'maturing', 'lair', 'influence']],
  ['bite', ['bitten', 'status', 'vampire']],
  ['fight', ['combat']],
  ['kill', ['defeat', 'damage', 'combat']],
  ['find', ['search', 'reveal', 'trail', 'deduction']],
  ['train', ['rail', 'ticket']]
]);

const tokenizeForSearch = (value) =>
  String(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normalizeSearchTerm)
    .filter((term) => term.length >= 2 && !stopWords.has(term));

const buildSearchTerms = (value) => {
  const primary = [...new Set(tokenizeForSearch(value))];
  const expanded = new Set(primary);
  for (const term of primary) {
    const aliases = searchAliases.get(term) ?? [];
    for (const alias of aliases) {
      expanded.add(normalizeSearchTerm(alias));
    }
  }
  return { primary, expanded: [...expanded] };
};

const normalizeSearchTerm = (term) => {
  if (term.length > 5 && term.endsWith('ing')) {
    return term.slice(0, -3);
  }
  if (term.length > 4 && term.endsWith('ies')) {
    return `${term.slice(0, -3)}y`;
  }
  if (term.length > 4 && term.endsWith('ed')) {
    return term.slice(0, -2);
  }
  if (term.length > 3 && term.endsWith('es')) {
    return term.slice(0, -2);
  }
  if (term.length > 3 && term.endsWith('s')) {
    return term.slice(0, -1);
  }
  return term;
};

const scoreDocument = (document, terms) => {
  const titleTerms = new Set(tokenizeForSearch(document.title));
  const tagTerms = new Set(document.tags.flatMap((tag) => tokenizeForSearch(tag)));
  const documentTerms = new Set(tokenizeForSearch(`${document.title} ${document.content} ${document.tags.join(' ')}`));
  return terms.expanded.reduce((score, term) => {
    const isPrimaryTerm = terms.primary.includes(term);
    if (documentTerms.has(term)) {
      const baseScore = isPrimaryTerm ? 5 : 2;
      const titleScore = titleTerms.has(term) ? 4 : 0;
      const tagScore = tagTerms.has(term) ? 2 : 0;
      return score + baseScore + titleScore + tagScore;
    }
    for (const documentTerm of documentTerms) {
      if (documentTerm.includes(term) || term.includes(documentTerm)) {
        return score + 1;
      }
    }
    return score;
  }, 0);
};

const toolError = (requestId, message) => ({
  requestId,
  ok: false,
  error: { code: 'INVALID_TOOL_ARGUMENTS', message, retryable: false }
});

export default {
  id: 'ground-truth-search',
  tools: [searchKnowledgeBase]
};
