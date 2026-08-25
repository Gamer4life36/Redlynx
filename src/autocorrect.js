/**
 * Autocorrect for the address bar.
 *
 * Deliberately a suggestion, never a rewrite. Silently changing what someone
 * typed is how you end up searching for the wrong thing and not knowing why,
 * so Enter always does exactly what is in the box — the correction appears as
 * a row you can choose.
 *
 * Three vocabularies, in order of how much they are trusted:
 *   1. Words from your own history and bookmarks. If you have searched it
 *      before, it is a real word to you, whatever a dictionary says.
 *   2. Sites people actually type, so "yotube" resolves to somewhere.
 *   3. Common English, for ordinary prose typos.
 *
 * No dictionary is downloaded and nothing is sent anywhere: the correction is
 * computed here from data already on the machine.
 */

// Adjacent keys on QWERTY. A substitution between neighbours is far likelier
// than between letters on opposite sides of the keyboard, so it costs less.
const NEIGHBOURS = {
  q: 'wa', w: 'qeas', e: 'wrsd', r: 'etdf', t: 'ryfg', y: 'tuhg', u: 'yijh',
  i: 'uokj', o: 'iplk', p: 'ol', a: 'qwsz', s: 'awedxz', d: 'serfcx',
  f: 'drtgvc', g: 'ftyhbv', h: 'gyujnb', j: 'huikmn', k: 'jiolm', l: 'kop',
  z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
};
function nearKey(a, b) {
  const row = NEIGHBOURS[a];
  return !!row && row.indexOf(b) !== -1;
}

// Sites people type by hand often enough to fat-finger.
const SITES = [
  'google.com', 'youtube.com', 'facebook.com', 'wikipedia.org', 'reddit.com',
  'amazon.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com',
  'netflix.com', 'twitch.tv', 'github.com', 'gitlab.com', 'stackoverflow.com',
  'ebay.com', 'paypal.com', 'yahoo.com', 'bing.com', 'duckduckgo.com',
  'microsoft.com', 'apple.com', 'office.com', 'outlook.com', 'gmail.com',
  'spotify.com', 'discord.com', 'tiktok.com', 'pinterest.com', 'tumblr.com',
  'imgur.com', 'craigslist.org', 'walmart.com', 'target.com', 'bestbuy.com',
  'nytimes.com', 'bbc.co.uk', 'cnn.com', 'espn.com', 'weather.com',
  'archive.org', 'wayback.org', 'openai.com', 'anthropic.com', 'claude.ai',
  'chatgpt.com', 'huggingface.co', 'npmjs.com', 'python.org', 'nodejs.org',
  'mozilla.org', 'torproject.org', 'protonmail.com', 'dropbox.com', 'drive.google.com',
];

// Common English, weighted toward what people put in a search box. Short
// enough to keep in the source, long enough to catch ordinary typos.
const COMMON = ('the be to of and a in that have i it for not on with he as you do at this but his by from '
  + 'they we say her she or an will my one all would there their what so up out if about who get which go me '
  + 'when make can like time no just him know take people into year your good some could them see other than '
  + 'then now look only come its over think also back after use two how our work first well way even new want '
  + 'because any these give day most us man find here thing tell very still should never last another while '
  + 'own under might great same tell does part place where turn move right old too little world life become '
  + 'through best need home water long down side something between important both often local really change '
  + 'point large small course company group problem number system program question during without again '
  + 'against family child school student teacher friend house money story example business服 government '
  + 'health history music video movie film photo picture image download upload install update version '
  + 'software hardware computer laptop phone mobile android windows linux server network internet website '
  + 'browser email password account login register search engine result page site online offline free trial '
  + 'price cheap review rating compare buy order shipping delivery return refund customer service support '
  + 'contact address phone number location map direction distance travel flight hotel restaurant recipe food '
  + 'weather forecast temperature rain snow storm season summer winter spring autumn morning evening night '
  + 'today tomorrow yesterday week month year date time hour minute second calendar schedule meeting event '
  + 'python javascript typescript java rust golang docker kubernetes database server error exception debug '
  + 'function variable array object string number boolean class method library framework package module '
  + 'install command terminal console script build deploy release commit branch merge repository '
  + 'science physics chemistry biology mathematics geometry algebra history geography language english '
  + 'spanish french german chinese japanese korean university college course lesson tutorial guide manual '
  + 'definition meaning synonym translate calculator converter generator template example sample '
  + 'football basketball baseball soccer tennis cricket hockey golf racing player team league season match '
  + 'election president government minister policy economy market stock price inflation interest tax '
  + 'medicine doctor hospital symptom treatment disease vaccine exercise fitness workout nutrition vitamin '
  + 'receive believe achieve separate definitely necessary occurred beginning until across tomorrow business '
  + 'restaurant environment government interesting beautiful different because friend though thought through'
).split(/\s+/).filter(Boolean);


// Classic misspellings, where the correction is not a guess. A small map of
// certainties beats a large dictionary of maybes: with a general word list,
// any real word missing from it gets dragged to the nearest entry, which is
// how "electron" became "election" and "cat" became "can".
const MISSPELLINGS = {
  teh: 'the', hte: 'the', adn: 'and', nad: 'and', taht: 'that', tihs: 'this',
  recieve: 'receive', recieved: 'received', beleive: 'believe', beleived: 'believed',
  acheive: 'achieve', acheived: 'achieved', seperate: 'separate', seperated: 'separated',
  definately: 'definitely', definatly: 'definitely', defiantly: 'definitely',
  neccessary: 'necessary', necesary: 'necessary', occured: 'occurred', occuring: 'occurring',
  begining: 'beginning', untill: 'until', accross: 'across', alot: 'a lot',
  arguement: 'argument', calender: 'calendar', cemetary: 'cemetery', changable: 'changeable',
  collegue: 'colleague', comming: 'coming', commited: 'committed', concious: 'conscious',
  embarass: 'embarrass', enviroment: 'environment', existance: 'existence',
  familar: 'familiar', finaly: 'finally', foriegn: 'foreign', freind: 'friend',
  goverment: 'government', gaurd: 'guard', happend: 'happened', harrassment: 'harassment',
  independant: 'independent', intresting: 'interesting', knowlege: 'knowledge',
  liesure: 'leisure', libary: 'library', maintainance: 'maintenance', millenium: 'millennium',
  noticable: 'noticeable', occassion: 'occasion', occurance: 'occurrence', paralell: 'parallel',
  persistant: 'persistent', posession: 'possession', prefered: 'preferred', privelege: 'privilege',
  probaly: 'probably', publically: 'publicly', reccomend: 'recommend', refered: 'referred',
  relevent: 'relevant', religous: 'religious', restaraunt: 'restaurant', rythm: 'rhythm',
  sucessful: 'successful', supercede: 'supersede', suprise: 'surprise', tommorow: 'tomorrow',
  tomorow: 'tomorrow', truely: 'truly', unfortunatly: 'unfortunately', usualy: 'usually',
  vaccum: 'vacuum', wierd: 'weird', wich: 'which', whcih: 'which', wtih: 'with',
  yuo: 'you', taek: 'take', pyhton: 'python', pythno: 'python', javascrpit: 'javascript',
  javascirpt: 'javascript', downlaod: 'download', dowload: 'download', udpate: 'update',
  serach: 'search', seach: 'search', searhc: 'search', brwoser: 'browser', browswer: 'browser',
  passowrd: 'password', pasword: 'password', acount: 'account', accont: 'account',
  lenght: 'length', widht: 'width', heigth: 'height', recieving: 'receiving',
};

// A word is not "unknown" merely because its plural or tense is missing from
// the list. Without this, "results" corrected to "result".
const SUFFIXES = ['s', 'es', 'ed', 'd', 'ing', 'ly', 'er', 'ers', 'est', 'ion', 'ions'];
function knownWithMorphology(word, inVocab) {
  if (inVocab(word)) return true;
  for (const suf of SUFFIXES) {
    if (word.length > suf.length + 2 && word.endsWith(suf)) {
      const stem = word.slice(0, -suf.length);
      if (inVocab(stem)) return true;
      // "carries" -> "carry", "running" -> "run"
      if (inVocab(stem + 'e')) return true;
      if (stem.endsWith('i') && inVocab(stem.slice(0, -1) + 'y')) return true;
      if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]
          && inVocab(stem.slice(0, -1))) return true;
    }
  }
  return false;
}

let dynamic = new Map();   // word -> weight, harvested from the user's own data
let base = null;

function baseVocab() {
  if (base) return base;
  base = new Map();
  COMMON.forEach((w) => { if (w.length > 2) base.set(w, 2); });
  SITES.forEach((d) => {
    base.set(d, 3);
    // "yotube" is a search, not an address, so the bare name has to be a word
    // in its own right or nothing matches it.
    const bare = d.replace(/\.(com|org|net|tv|co\.uk|ai|io|co)$/, '').split('.').pop();
    if (bare && bare.length > 3) base.set(bare, 3);
  });
  return base;
}

/**
 * Feed in the user's history and bookmark titles. Their own vocabulary beats
 * any built-in list: a name that appears in their history is a word they mean.
 */
function learn(texts) {
  const counts = new Map();
  for (const t of texts || []) {
    const words = String(t || '').toLowerCase().match(/[a-z][a-z'-]{2,}|[a-z0-9-]+\.[a-z]{2,}/g);
    if (!words) continue;
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  }
  dynamic = counts;
}

function known(word) {
  const inVocab = (w) => dynamic.has(w) || baseVocab().has(w);
  return knownWithMorphology(word, inVocab);
}

function weightOf(word) {
  // Something seen five times in your own history outranks a dictionary entry.
  return (dynamic.get(word) || 0) * 3 + (baseVocab().get(word) || 0);
}

/**
 * Damerau-Levenshtein, with adjacent-key substitutions counted as half a step
 * and an early bail once a candidate is already too far away.
 */
function distance(a, b, limit) {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > limit) return Infinity;
  let prev2 = null;
  let prev = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    const cur = new Array(bl + 1);
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= bl; j++) {
      const ca = a[i - 1];
      const cb = b[j - 1];
      const sub = ca === cb ? 0 : (nearKey(ca, cb) ? 0.5 : 1);
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub);
      // transposition: "teh" -> "the"
      if (i > 1 && j > 1 && ca === b[j - 2] && a[i - 2] === cb) {
        v = Math.min(v, prev2[j - 2] + 0.75);
      }
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > limit) return Infinity;
    prev2 = prev;
    prev = cur;
  }
  return prev[bl];
}

function correctWord(word) {
  const w = word.toLowerCase();

  // A known misspelling is a fact, so it applies at any length.
  if (MISSPELLINGS[w]) return MISSPELLINGS[w];

  // Beyond that, only correct toward something there is evidence for: a word
  // from the user's own history, or a site name. Correcting toward a generic
  // word list turns real words the list happens to lack into nonsense.
  if (w.length < 5 || known(w) || /\d/.test(w)) return null;

  const limit = w.length <= 7 ? 1 : 2;
  let best = null;
  let bestScore = Infinity;

  const consider = (cand, weight) => {
    if (cand === w || Math.abs(cand.length - w.length) > limit) return;
    const d = distance(w, cand, limit);
    if (d === Infinity || d > limit) return;
    const score = d - Math.min(weight, 9) / 100;
    if (score < bestScore) { bestScore = score; best = cand; }
  };

  // The user's own vocabulary, then site names — both are evidence that this
  // specific word is one they meant.
  for (const [cand, count] of dynamic) { if (cand.length >= 5) consider(cand, count * 3); }
  for (const site of SITES) {
    const bare = site.replace(/\.(com|org|net|tv|ai|io|co)$/, '').split('.').pop();
    if (bare.length >= 5) consider(bare, 3);
  }

  return best;
}

/**
 * Returns a corrected version of the query, or null when nothing looks wrong.
 * Only whole words are touched, and the original spacing is preserved.
 */
function correct(query) {
  const q = String(query || '');
  if (!q.trim() || q.length > 120) return null;
  // Addresses and anything with a scheme are not prose — leave them be, except
  // for a straight domain typo, handled below.
  if (/^[a-z]+:\/\//i.test(q)) return null;

  const isDomain = /^[\w-]+(\.[\w-]+)+$/.test(q.trim()) && !/\s/.test(q);
  if (isDomain) {
    const d = q.trim().toLowerCase();
    if (known(d)) return null;
    let best = null;
    let bestD = Infinity;
    for (const site of SITES) {
      const dist = distance(d, site, 2);
      if (dist < bestD && dist <= 2) { bestD = dist; best = site; }
    }
    return best && best !== d ? best : null;
  }

  const parts = q.split(/(\s+)/);       // keeps the separators
  let changed = false;
  const fixed = parts.map((p) => {
    if (/^\s+$/.test(p) || !/^[a-zA-Z'-]+$/.test(p)) return p;
    const c = correctWord(p);
    if (!c) return p;
    changed = true;
    // Match the original capitalisation of the first letter.
    return /^[A-Z]/.test(p) ? c[0].toUpperCase() + c.slice(1) : c;
  });
  return changed ? fixed.join('') : null;
}

module.exports = { correct, learn, known, distance };
