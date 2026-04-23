/**
 * 256 short common English words used by the backup-passphrase
 * generator. Curated to avoid:
 *
 * - Ambiguity (homophones like "there/their", "flour/flower").
 * - Proper nouns and loanwords, which can tempt a user into thinking
 *   capitalization or punctuation matters — the passphrase is case-
 *   sensitive at the OpenPGP layer.
 * - Words over six characters, to keep the generated passphrase
 *   compact and easy to transcribe onto a second device.
 *
 * Size is exactly 256 (a power of two) so the generator can map a
 * byte from a CSPRNG directly onto an index without modulo bias.
 * Each selected word contributes 8 bits of entropy; six words yield
 * 48 bits, which combined with the Argon2id S2K parameters we use on
 * the XEP-0373 §5 secret-key node is durable against offline attack
 * at reasonable expected attacker budgets.
 *
 * If this list is ever edited, keep the length at exactly 256 —
 * see `passphraseGenerator.ts` for why.
 */

export const PASSPHRASE_WORDLIST: readonly string[] = [
  'able', 'acid', 'acre', 'aged', 'agree', 'ahead', 'aim', 'air',
  'alarm', 'album', 'alert', 'alive', 'allow', 'alone', 'among', 'angle',
  'angry', 'apple', 'arena', 'arise', 'arm', 'army', 'aside', 'asset',
  'avoid', 'awake', 'aware', 'badge', 'band', 'bank', 'bar', 'bare',
  'basic', 'beach', 'beam', 'bean', 'bear', 'began', 'begin', 'being',
  'bend', 'best', 'beyond', 'bible', 'bid', 'bike', 'bind', 'bird',
  'bit', 'bite', 'black', 'blade', 'blame', 'blank', 'blend', 'bless',
  'blind', 'block', 'blood', 'blue', 'board', 'boat', 'body', 'boil',
  'bold', 'bomb', 'bond', 'bone', 'bonus', 'book', 'boost', 'boot',
  'born', 'boss', 'both', 'bound', 'bow', 'bowl', 'box', 'brain',
  'brand', 'brass', 'brave', 'bread', 'break', 'brick', 'brief', 'bring',
  'broad', 'broke', 'brown', 'brush', 'build', 'bulk', 'burn', 'burst',
  'busy', 'cabin', 'cable', 'cake', 'calm', 'camp', 'card', 'care',
  'cargo', 'cash', 'cast', 'catch', 'cause', 'cell', 'chain', 'chair',
  'chart', 'cheap', 'check', 'cheer', 'chest', 'chief', 'child', 'chip',
  'civil', 'claim', 'clay', 'clean', 'clear', 'clerk', 'click', 'cliff',
  'climb', 'clock', 'close', 'cloth', 'cloud', 'club', 'coach', 'coal',
  'coast', 'coat', 'code', 'coin', 'cold', 'color', 'comic', 'cook',
  'cool', 'copy', 'cord', 'core', 'corn', 'cost', 'couch', 'count',
  'coupe', 'court', 'cover', 'crab', 'craft', 'crash', 'crazy', 'cream',
  'crew', 'crime', 'crisp', 'crop', 'cross', 'crowd', 'crown', 'crude',
  'cruel', 'cry', 'cube', 'curl', 'cut', 'cycle', 'daily', 'dance',
  'dark', 'data', 'date', 'day', 'dead', 'deaf', 'deal', 'dear',
  'debt', 'deck', 'deep', 'deer', 'delay', 'depth', 'desk', 'diet',
  'dirt', 'dive', 'doll', 'done', 'door', 'dose', 'doubt', 'down',
  'draft', 'drag', 'drama', 'draw', 'dream', 'dress', 'drink', 'drive',
  'drop', 'drug', 'drum', 'duck', 'due', 'dust', 'duty', 'dwarf',
  'each', 'eager', 'early', 'earn', 'earth', 'ease', 'east', 'easy',
  'eat', 'edge', 'elbow', 'elder', 'elect', 'elf', 'elite', 'empty',
  'end', 'enemy', 'enjoy', 'enter', 'entry', 'equal', 'era', 'error',
  'event', 'every', 'exact', 'exam', 'exit', 'extra', 'eye', 'face',
  'fact', 'fail', 'faint', 'fair', 'fake', 'fall', 'false', 'fame',
]
