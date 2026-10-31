/**
 * Mutation scripts over the caption fixtures (spec 9.2, research 3's edge
 * table): each one a fixture, timed steps that change the page as Meet or
 * Teams does, and the lines a transcript should end with. The tracker tests
 * (MX4) run every one; the call watch's two (the in-call hooks gone for 10 s
 * and back, a new Meet code) are in CALL_SCRIPTS.
 *
 *   for (const s of SCRIPTS) {
 *     const fx = s.build(document);
 *     for (const step of s.steps) { clock += step.wait; step.run(fx); scan(); }
 *     expect(finalLines).toEqual(s.expect);
 *   }
 */
import { buildMeet, meetUrl, type MeetFixture, type MeetTurn } from './meet.js';
import { buildTeams, type TeamsFixture, type TeamsItem } from './teams.js';

export interface ExpectedLine {
  speaker: string;
  text: string;
}

export type Fixture = MeetFixture | TeamsFixture;

export interface ScriptStep {
  /** Milliseconds after the step before. */
  wait: number;
  run(fx: Fixture): void;
}

export interface MutationScript {
  name: string;
  site: 'meet' | 'teams';
  build(doc: Document): Fixture;
  steps: ScriptStep[];
  /** The transcript's lines at the end, in the order they were first seen. */
  expect: ExpectedLine[];
}

const meet = (fx: Fixture) => fx as MeetFixture;
const teams = (fx: Fixture) => fx as TeamsFixture;
const turn = (fx: Fixture, i: number): MeetTurn => meet(fx).turns[i]!;
const item = (fx: Fixture, i: number): TeamsItem => teams(fx).items[i]!;
const step = (wait: number, run: (fx: Fixture) => void): ScriptStep => ({ wait, run });

/** Forty words of one speaker, with sentence ends, for the long-turn scripts. */
const LONG_A =
  'Thanks everyone for joining today. The first thing on the list is the launch plan for the new site. We moved the date twice already, so this time we want to hold it. The second thing is the quote for the printing job, which came in higher than we hoped.';
const LONG_B =
  'So I asked them to look at the paper again, and they said they can bring it down a little if we order before the end of the month. That would still leave us a week to proof the final files.';
/** Over 250 characters with no sentence end: Meet's 30-minute reset shrinks it by more than RESET_SHRINK. */
const LONG_C =
  'and the room booking for the workshop is still open because the venue wants a deposit first and nobody has signed the form yet so we keep holding the slot on the calendar while the finance team checks whether the old purchase order still covers it or whether we need a new one from the board';

export const SCRIPTS: MutationScript[] = [
  {
    name: 'grow',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [
      step(0, (fx) => meet(fx).say('Sam', 'So the plan')),
      step(400, (fx) => turn(fx, 0).grow('for Friday is')),
      step(400, (fx) => turn(fx, 0).grow('to ship the new site.')),
    ],
    expect: [{ speaker: 'Sam', text: 'So the plan for Friday is to ship the new site.' }],
  },
  {
    name: 'rewrite the middle',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [
      step(0, (fx) => meet(fx).say('Priya', 'We should ship the bill on Friday')),
      step(500, (fx) => turn(fx, 0).set('We should ship the build on Friday morning')),
      step(500, (fx) => turn(fx, 0).set('We should ship the build on Friday morning, early.')),
    ],
    expect: [{ speaker: 'Priya', text: 'We should ship the build on Friday morning, early.' }],
  },
  {
    name: 'rewrite the whole line',
    site: 'teams',
    build: (doc) => buildTeams(doc, { layout: '2026-bottom' }),
    steps: [
      step(0, (fx) => teams(fx).say('Alex', 'I think the quote is too high')),
      step(600, (fx) => item(fx, 0).set('I think the quota is too high for us')),
    ],
    expect: [{ speaker: 'Alex', text: 'I think the quota is too high for us' }],
  },
  // Live captions revise word boundaries near the front all the time: each is one line with the revised text.
  {
    name: 'a contraction near the start',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [step(0, (fx) => meet(fx).say('Sam', 'It is a good idea')), step(500, (fx) => turn(fx, 0).set("It's a good idea"))],
    expect: [{ speaker: 'Sam', text: "It's a good idea" }],
  },
  {
    name: 'a contraction undone near the start',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [step(0, (fx) => meet(fx).say('Sam', "It's a good idea")), step(500, (fx) => turn(fx, 0).set('It is a good idea to ask them.'))],
    expect: [{ speaker: 'Sam', text: 'It is a good idea to ask them.' }],
  },
  {
    name: 'two words merged near the start',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [
      step(0, (fx) => meet(fx).say('Priya', 'I do not think the venue has replied yet')),
      step(500, (fx) => turn(fx, 0).set("I don't think the venue has replied yet.")),
      step(500, (fx) => meet(fx).say('Sam', 'So we can not ship it')),
      step(500, (fx) => turn(fx, 1).set('So we cannot ship it before May.')),
    ],
    expect: [
      { speaker: 'Priya', text: "I don't think the venue has replied yet." },
      { speaker: 'Sam', text: 'So we cannot ship it before May.' },
    ],
  },
  {
    name: 'a word split in two near the start',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [step(0, (fx) => meet(fx).say('Alex', "We're going to ship it on Friday")), step(500, (fx) => turn(fx, 0).set('We are going to ship it on Friday.'))],
    expect: [{ speaker: 'Alex', text: 'We are going to ship it on Friday.' }],
  },
  {
    name: 'a word added near the start',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [
      step(0, (fx) => meet(fx).say('Sam', 'We need two more chairs for the room')),
      step(500, (fx) => turn(fx, 0).set('We will need two more chairs for the room')),
      step(500, (fx) => turn(fx, 0).set('We will need two more chairs for the room, and a table.')),
    ],
    expect: [{ speaker: 'Sam', text: 'We will need two more chairs for the room, and a table.' }],
  },
  {
    name: 'a word dropped near the start',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [
      step(0, (fx) => meet(fx).say('Sam', 'We will need two more chairs for the room')),
      step(500, (fx) => turn(fx, 0).set('We need two more chairs for the room')),
      step(500, (fx) => meet(fx).say('Priya', 'We are gonna need a bigger room')),
      step(500, (fx) => turn(fx, 1).set('We are going to need a bigger room.')),
    ],
    expect: [
      { speaker: 'Sam', text: 'We need two more chairs for the room' },
      { speaker: 'Priya', text: 'We are going to need a bigger room.' },
    ],
  },
  {
    name: 'trim the front',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [
      step(0, (fx) => meet(fx).say('Sam', LONG_A.split(' ').slice(0, 30).join(' '))),
      step(800, (fx) => turn(fx, 0).set(LONG_A.split(' ').slice(12).join(' '))),
      step(800, (fx) => turn(fx, 0).set(LONG_A.split(' ').slice(20).join(' '))),
    ],
    expect: [{ speaker: 'Sam', text: LONG_A }],
  },
  {
    name: "Meet's 30-minute reset",
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [
      step(0, (fx) => meet(fx).say('Sam', LONG_C)),
      step(700, (fx) => turn(fx, 0).set('Right, so moving on')),
      step(700, (fx) => turn(fx, 0).grow('to the next item.')),
    ],
    expect: [
      { speaker: 'Sam', text: LONG_C },
      { speaker: 'Sam', text: 'Right, so moving on to the next item.' },
    ],
  },
  {
    name: 'a long turn splits at a sentence end',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [
      step(0, (fx) => meet(fx).say('Priya', LONG_A)),
      step(800, (fx) => turn(fx, 0).grow(LONG_B)),
    ],
    // Split after the last sentence end that leaves STABLE_TAIL characters behind it.
    expect: [
      { speaker: 'Priya', text: LONG_A },
      { speaker: 'Priya', text: LONG_B },
    ],
  },
  {
    name: 'a new speaker',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [
      step(0, (fx) => meet(fx).say('Sam', 'Can everyone see my screen?')),
      step(900, (fx) => meet(fx).say('You', 'Yes, it looks fine.')),
      step(900, (fx) => meet(fx).say('Priya', 'Same here, go ahead.')),
    ],
    expect: [
      { speaker: 'Sam', text: 'Can everyone see my screen?' },
      { speaker: 'You', text: 'Yes, it looks fine.' },
      { speaker: 'Priya', text: 'Same here, go ahead.' },
    ],
  },
  {
    name: 'an older block corrected after a newer one started',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [
      step(0, (fx) => meet(fx).say('Sam', 'The deadline is the fifth')),
      step(800, (fx) => meet(fx).say('Priya', 'That works for me.')),
      // Within SETTLE_MS: the correction lands on Sam's line.
      step(1_000, (fx) => turn(fx, 0).set('The deadline is the fifteenth')),
      // Long after the newer block: the line is final, a late change is dropped.
      step(9_000, (fx) => turn(fx, 0).set('The deadline is the fifteenth of May')),
    ],
    expect: [
      { speaker: 'Sam', text: 'The deadline is the fifteenth' },
      { speaker: 'Priya', text: 'That works for me.' },
    ],
  },
  {
    name: 'the same speaker after a pause',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [
      step(0, (fx) => meet(fx).say('Alex', 'Let me check the numbers.')),
      step(25_000, (fx) => turn(fx, 0).grow('Okay, they add up.')),
    ],
    expect: [
      { speaker: 'Alex', text: 'Let me check the numbers.' },
      { speaker: 'Alex', text: 'Okay, they add up.' },
    ],
  },
  {
    name: 'a missing name',
    site: 'teams',
    build: (doc) => buildTeams(doc, { layout: '2026-right' }),
    steps: [
      step(0, (fx) => teams(fx).say(null, 'Is this thing on?')),
      step(700, (fx) => teams(fx).say('Sam', 'Yes, we can hear you.')),
      step(700, (fx) => teams(fx).say(null, 'And I can share the deck now.')),
    ],
    expect: [
      { speaker: 'Unknown', text: 'Is this thing on?' },
      { speaker: 'Sam', text: 'Yes, we can hear you.' },
      { speaker: 'Sam', text: 'And I can share the deck now.' },
    ],
  },
  {
    name: 'a name filled in late',
    site: 'teams',
    build: (doc) => buildTeams(doc, { layout: 'v2' }),
    steps: [
      step(0, (fx) => teams(fx).say(null, 'Morning, sorry I am late')),
      step(600, (fx) => item(fx, 0).setAuthor('Priya')),
    ],
    expect: [{ speaker: 'Priya', text: 'Morning, sorry I am late' }],
  },
  {
    name: 'unmount and remount',
    site: 'teams',
    build: (doc) => buildTeams(doc, { layout: 'v2' }),
    steps: [
      step(0, (fx) => teams(fx).say('Sam', 'First we look at the budget for the quarter.')),
      step(700, (fx) => teams(fx).say('Priya', 'Then the hiring plan for the spring.')),
      step(700, (fx) => teams(fx).say('Alex', 'And last the office move in June.')),
      step(700, (fx) => teams(fx).unmount(item(fx, 0))),
      step(700, (fx) => teams(fx).remount(item(fx, 0))),
      step(700, (fx) => teams(fx).unmount(item(fx, 2))),
      step(700, (fx) => teams(fx).remount(item(fx, 2))),
      step(700, (fx) => teams(fx).say('Sam', 'Good, that is everything.')),
    ],
    expect: [
      { speaker: 'Sam', text: 'First we look at the budget for the quarter.' },
      { speaker: 'Priya', text: 'Then the hiring plan for the spring.' },
      { speaker: 'Alex', text: 'And last the office move in June.' },
      { speaker: 'Sam', text: 'Good, that is everything.' },
    ],
  },
  // A new item of five or more words is no copy of an older, gone line just because they share a word or a few end words.
  {
    name: 'an earlier "Okay." and a new item that holds the word',
    site: 'teams',
    build: (doc) => buildTeams(doc, { layout: 'v2' }),
    steps: [
      step(0, (fx) => teams(fx).say('Sam', 'Okay.')),
      step(700, (fx) => teams(fx).say('Priya', 'Can you share the deck?')),
      step(700, (fx) => teams(fx).say('Alex', 'I will send it after this.')),
      step(700, (fx) => teams(fx).say('Priya', 'Thanks, that works.')),
      step(700, (fx) => teams(fx).unmount(item(fx, 0))),
      step(700, (fx) => teams(fx).say('Sam', 'If that is okay with everyone we can move on to the budget.')),
    ],
    expect: [
      { speaker: 'Sam', text: 'Okay.' },
      { speaker: 'Priya', text: 'Can you share the deck?' },
      { speaker: 'Alex', text: 'I will send it after this.' },
      { speaker: 'Priya', text: 'Thanks, that works.' },
      { speaker: 'Sam', text: 'If that is okay with everyone we can move on to the budget.' },
    ],
  },
  {
    name: 'an earlier "Yeah." and a new item that grows from the word',
    site: 'teams',
    build: (doc) => buildTeams(doc, { layout: '2026-bottom' }),
    steps: [
      step(0, (fx) => teams(fx).say('Sam', 'Yeah.')),
      step(700, (fx) => teams(fx).say('Priya', 'Did the printer call back?')),
      step(700, (fx) => teams(fx).unmount(item(fx, 0))),
      step(700, (fx) => teams(fx).say('Sam', 'Yeah so the printer said')),
      step(500, (fx) => item(fx, 2).grow('Monday at the earliest.')),
    ],
    expect: [
      { speaker: 'Sam', text: 'Yeah.' },
      { speaker: 'Priya', text: 'Did the printer call back?' },
      { speaker: 'Sam', text: 'Yeah so the printer said Monday at the earliest.' },
    ],
  },
  {
    name: 'a new item that begins with the last words of an older one',
    site: 'teams',
    build: (doc) => buildTeams(doc, { layout: 'v2' }),
    steps: [
      step(0, (fx) => teams(fx).say('Sam', 'Next we look at the hiring plan.')),
      step(700, (fx) => teams(fx).say('Priya', 'Sounds good.')),
      step(700, (fx) => teams(fx).unmount(item(fx, 0))),
      step(700, (fx) => teams(fx).say('Sam', 'The hiring plan has two new roles')),
      step(500, (fx) => item(fx, 2).grow('for the spring.')),
    ],
    expect: [
      { speaker: 'Sam', text: 'Next we look at the hiring plan.' },
      { speaker: 'Priya', text: 'Sounds good.' },
      { speaker: 'Sam', text: 'The hiring plan has two new roles for the spring.' },
    ],
  },
  {
    name: 'no names on screen: a short line and a line end are no copies either',
    site: 'teams',
    build: (doc) => buildTeams(doc, { layout: '2026-right' }),
    steps: [
      step(0, (fx) => teams(fx).say(null, 'Right.')),
      step(700, (fx) => teams(fx).say(null, 'Can you share the deck?')),
      step(700, (fx) => teams(fx).say(null, 'Next we look at the hiring plan.')),
      step(700, (fx) => teams(fx).unmount(item(fx, 0))),
      step(700, (fx) => teams(fx).say(null, 'We should get the numbers right before the board sees them.')),
      step(700, (fx) => teams(fx).unmount(item(fx, 2))),
      step(700, (fx) => teams(fx).say(null, 'The hiring plan')),
      step(500, (fx) => item(fx, 4).grow('has two new roles for the spring.')),
    ],
    expect: [
      { speaker: 'Unknown', text: 'Right.' },
      { speaker: 'Unknown', text: 'Can you share the deck?' },
      { speaker: 'Unknown', text: 'Next we look at the hiring plan.' },
      { speaker: 'Unknown', text: 'We should get the numbers right before the board sees them.' },
      { speaker: 'Unknown', text: 'The hiring plan has two new roles for the spring.' },
    ],
  },
  {
    name: 'replace the region',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [
      step(0, (fx) => meet(fx).say('Sam', 'We need two more people on the team')),
      step(700, (fx) => meet(fx).say('Priya', 'One of them could start next month')),
      step(700, (fx) => meet(fx).replaceRegion()),
      step(700, (fx) => turn(fx, 1).grow('if the budget allows it.')),
    ],
    expect: [
      { speaker: 'Sam', text: 'We need two more people on the team' },
      { speaker: 'Priya', text: 'One of them could start next month if the budget allows it.' },
    ],
  },
  {
    name: 'captions off then on',
    site: 'meet',
    build: (doc) => buildMeet(doc),
    steps: [
      step(0, (fx) => meet(fx).say('Sam', 'Before we stop I want to thank everyone')),
      step(700, (fx) => meet(fx).captionsOff()),
      step(3_000, (fx) => meet(fx).captionsOn()),
      step(700, (fx) => meet(fx).say('Priya', 'Thanks Sam, see you all next week.')),
    ],
    expect: [
      { speaker: 'Sam', text: 'Before we stop I want to thank everyone' },
      { speaker: 'Priya', text: 'Thanks Sam, see you all next week.' },
    ],
  },
  {
    name: 'renamed classes (the structural fallback)',
    site: 'meet',
    build: (doc) => buildMeet(doc, { renamed: true }),
    steps: [
      step(0, (fx) => meet(fx).say('Sam', 'The fallback still reads')),
      step(500, (fx) => turn(fx, 0).grow('every turn on the page.')),
      step(500, (fx) => meet(fx).say('You', 'Good to know.')),
    ],
    expect: [
      { speaker: 'Sam', text: 'The fallback still reads every turn on the page.' },
      { speaker: 'You', text: 'Good to know.' },
    ],
  },
];

export interface CallScript {
  name: string;
  build(doc: Document): Fixture;
  steps: ScriptStep[];
}

/** The call watch's scripts (MX5): the page's URL is set by the test (`meetUrl`). */
export const CALL_SCRIPTS: CallScript[] = [
  {
    name: 'the in-call hooks gone for 10 s and back',
    build: (doc) => buildMeet(doc),
    steps: [step(5_000, (fx) => meet(fx).hooksOff()), step(10_000, (fx) => meet(fx).hooksOn())],
  },
  {
    name: 'a new Meet code',
    build: (doc) => buildMeet(doc),
    steps: [step(5_000, (fx) => fx.doc.defaultView?.history.pushState({}, '', meetUrl('xyz-abcd-efg')))],
  },
];
