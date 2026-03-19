require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const JWT_SECRET = process.env.JWT_SECRET || 'czech-tutor-secret-key-2026';

// --- DATABASE SETUP ---
const db = new Database(path.join(__dirname, 'czech-tutor.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student',
    name TEXT NOT NULL,
    xp INTEGER DEFAULT 0,
    streak INTEGER DEFAULT 0,
    last_active TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    level TEXT DEFAULT 'A2',
    min_messages INTEGER DEFAULT 10,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS topic_assignments (
    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES users(id),
    submitted_at TEXT DEFAULT NULL,
    PRIMARY KEY (topic_id, student_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS vocabulary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    word TEXT NOT NULL,
    translation TEXT,
    context_sentence TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    badge_key TEXT NOT NULL,
    earned_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, badge_key)
  );
  CREATE TABLE IF NOT EXISTS evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES users(id),
    score INTEGER,
    grade TEXT,
    evaluation TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default users if empty
const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
if (userCount === 0) {
  const hash1 = bcrypt.hashSync('ucitel123', 10);
  const hash2 = bcrypt.hashSync('zak123', 10);
  db.prepare('INSERT INTO users (username, password, role, name) VALUES (?, ?, ?, ?)').run('ucitel', hash1, 'teacher', 'Učitel');
  db.prepare('INSERT INTO users (username, password, role, name) VALUES (?, ?, ?, ?)').run('zak', hash2, 'student', 'Žák Adam');
  console.log('Default users created');
}

// --- TOPIC TEMPLATES ---
const TOPIC_TEMPLATES = [
  { title: 'V restauraci', description: 'Student si objednává jídlo a pití v české restauraci. Číšník nabízí menu.', level: 'A2' },
  { title: 'U lékaře', description: 'Student popisuje své zdravotní potíže a lékař se ptá na symptomy.', level: 'B1' },
  { title: 'Na poště', description: 'Student chce poslat balík a dopis. Ptá se na ceny a dobu doručení.', level: 'A2' },
  { title: 'Hledám byt', description: 'Student si prohlíží byt a ptá se majitele na nájem, vybavení a okolí.', level: 'B1' },
  { title: 'V obchodě s oblečením', description: 'Student hledá oblečení, ptá se na velikosti, barvy a ceny.', level: 'A1' },
  { title: 'Na nádraží', description: 'Student kupuje jízdenku a ptá se na spoje, nástupiště a zpoždění.', level: 'A2' },
  { title: 'Pohovor do práce', description: 'Student je na pracovním pohovoru. Představuje se a odpovídá na otázky.', level: 'B2' },
  { title: 'Telefonování', description: 'Student volá na úřad nebo do firmy a řeší záležitost po telefonu.', level: 'B1' },
  { title: 'Vyprávění o víkendu', description: 'Student popisuje, co dělal o víkendu, a ptá se partnera na jeho plány.', level: 'A2' },
  { title: 'Cestování po ČR', description: 'Student plánuje výlet po České republice a ptá se na zajímavá místa.', level: 'B1' },
];

const DAILY_TIPS = [
  { title: 'Slovo dne', text: '„pohodový“ – znamená „klidný, uvolněný“. Například: „Dnes mám pohodový den.“' },
  { title: 'Tip dne', text: 'Když chceš říct „I like it“, můžeš říct „Líbí se mi to.“' },
  { title: 'Tip dne', text: 'Pro otázku „Kde je…?“ použij „Kde je?“ + místo (např. „Kde je nejbližší kavárna?“).' },
  { title: 'Slovo dne', text: '„běhat“ znamená „run“. Například: „Každý den běhám v parku.“' },
  { title: 'Tip dne', text: 'Opisuj větu, pokud si nejsi jistý: „Můžeš to napsat jinak?“' },
];

// --- BADGE DEFINITIONS ---
const BADGE_DEFS = {
  first_message: { name: 'První zpráva', emoji: '🎯', desc: 'Poslal/a jsi první zprávu' },
  messages_10: { name: 'Konverzátor', emoji: '💬', desc: '10 zpráv odesláno' },
  messages_50: { name: 'Řečník', emoji: '🗣️', desc: '50 zpráv odesláno' },
  messages_100: { name: 'Mistr slova', emoji: '📚', desc: '100 zpráv odesláno' },
  topics_3: { name: 'Průzkumník', emoji: '🧭', desc: '3 témata vyzkoušena' },
  topics_5: { name: 'Polyglot', emoji: '🌍', desc: '5 témat vyzkoušena' },
  streak_3: { name: 'Na vlně', emoji: '🔥', desc: '3 dny v řadě' },
  streak_7: { name: 'Vytrvlý', emoji: '⚡', desc: '7 dní v řadě' },
  vocab_10: { name: 'Sběratel slov', emoji: '📖', desc: '10 slov ve slovníčku' },
  xp_100: { name: 'Začátečník', emoji: '⭐', desc: '100 XP nasbíráno' },
  xp_500: { name: 'Pokročilý', emoji: '🏆', desc: '500 XP nasbíráno' },
};

function checkAndAwardBadges(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE user_id = ? AND role = ?').get(userId, 'user').cnt;
  const topicCount = db.prepare('SELECT COUNT(DISTINCT topic_id) as cnt FROM messages WHERE user_id = ? AND role = ?').get(userId, 'user').cnt;
  const vocabCount = db.prepare('SELECT COUNT(*) as cnt FROM vocabulary WHERE user_id = ?').get(userId).cnt;

  const checks = [
    { key: 'first_message', cond: msgCount >= 1 },
    { key: 'messages_10', cond: msgCount >= 10 },
    { key: 'messages_50', cond: msgCount >= 50 },
    { key: 'messages_100', cond: msgCount >= 100 },
    { key: 'topics_3', cond: topicCount >= 3 },
    { key: 'topics_5', cond: topicCount >= 5 },
    { key: 'streak_3', cond: user.streak >= 3 },
    { key: 'streak_7', cond: user.streak >= 7 },
    { key: 'vocab_10', cond: vocabCount >= 10 },
    { key: 'xp_100', cond: user.xp >= 100 },
    { key: 'xp_500', cond: user.xp >= 500 },
  ];

  const newBadges = [];
  const insert = db.prepare('INSERT OR IGNORE INTO badges (user_id, badge_key) VALUES (?, ?)');
  for (const { key, cond } of checks) {
    if (cond) {
      const result = insert.run(userId, key);
      if (result.changes > 0) newBadges.push(key);
    }
  }
  return newBadges;
}

function updateStreak(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const today = new Date().toISOString().split('T')[0];
  const lastActive = user.last_active ? user.last_active.split('T')[0] : null;

  if (lastActive === today) return; // Already active today

  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const newStreak = lastActive === yesterday ? user.streak + 1 : 1;

  db.prepare('UPDATE users SET streak = ?, last_active = ? WHERE id = ?').run(newStreak, new Date().toISOString(), userId);
}

// --- AUTH MIDDLEWARE ---
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Nepřihlášen' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Neplatný token' });
  }
}

// --- AUTH ROUTES ---
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Špatné přihlašovací údaje' });
  }
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ id: user.id, username: user.username, role: user.role, name: user.name, token });
});

app.post('/api/auth/register', (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'Vyplň všechna pole' });
  if (username.length < 3) return res.status(400).json({ error: 'Uživatelské jméno musí mít min. 3 znaky' });
  if (password.length < 4) return res.status(400).json({ error: 'Heslo musí mít min. 4 znaky' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Uživatelské jméno je obsazené' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password, role, name) VALUES (?, ?, ?, ?)').run(username, hash, 'student', name);
  const token = jwt.sign({ id: result.lastInsertRowid, role: 'student' }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ id: result.lastInsertRowid, username, role: 'student', name, token });
});

// --- TOPICS ---
app.get('/api/daily-tip', auth, (req, res) => {
  const day = new Date().toISOString().slice(0, 10)
  const idx = [...day].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % DAILY_TIPS.length
  res.json(DAILY_TIPS[idx])
})

app.get('/api/topics', auth, (req, res) => {
  if (req.user.role === 'teacher') {
    const topics = db.prepare('SELECT * FROM topics ORDER BY created_at DESC').all();
    for (const t of topics) {
      const assignments = db.prepare('SELECT student_id, submitted_at FROM topic_assignments WHERE topic_id = ?').all(t.id);
      t.assignedTo = assignments.map(r => r.student_id);
      t.submissions = {};
      for (const a of assignments) {
        if (a.submitted_at) t.submissions[a.student_id] = a.submitted_at;
      }
    }
    return res.json(topics);
  }
  const topics = db.prepare(`
    SELECT t.*, ta.submitted_at FROM topics t
    JOIN topic_assignments ta ON ta.topic_id = t.id
    WHERE ta.student_id = ?
    ORDER BY t.created_at DESC
  `).all(req.user.id);
  for (const t of topics) {
    t.assignedTo = db.prepare('SELECT student_id FROM topic_assignments WHERE topic_id = ?').all(t.id).map(r => r.student_id);
    t.messageCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE user_id = ? AND topic_id = ? AND role = ?').get(req.user.id, t.id, 'user').cnt;
  }
  res.json(topics);
});

app.post('/api/topics', auth, (req, res) => {
  const { title, description, level, minMessages } = req.body;
  const result = db.prepare('INSERT INTO topics (title, description, level, min_messages, created_by) VALUES (?, ?, ?, ?, ?)').run(title, description || '', level || 'A2', minMessages || 10, req.user.id);
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(result.lastInsertRowid);
  topic.assignedTo = [];
  res.status(201).json(topic);
});

app.delete('/api/topics/:id', auth, (req, res) => {
  const result = db.prepare('DELETE FROM topics WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Téma nenalezeno' });
  res.json({ ok: true });
});

app.post('/api/topics/:id/assign', auth, (req, res) => {
  const { studentId } = req.body;
  db.prepare('INSERT OR IGNORE INTO topic_assignments (topic_id, student_id) VALUES (?, ?)').run(req.params.id, studentId);
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(req.params.id);
  if (!topic) return res.status(404).json({ error: 'Téma nenalezeno' });
  topic.assignedTo = db.prepare('SELECT student_id FROM topic_assignments WHERE topic_id = ?').all(topic.id).map(r => r.student_id);
  res.json(topic);
});

// --- SUBMIT WORK ---
app.post('/api/topics/:topicId/submit', auth, (req, res) => {
  const topicId = Number(req.params.topicId);
  const userId = req.user.id;
  const assignment = db.prepare('SELECT * FROM topic_assignments WHERE topic_id = ? AND student_id = ?').get(topicId, userId);
  if (!assignment) return res.status(404).json({ error: 'Přiřazení nenalezeno' });
  if (assignment.submitted_at) return res.status(400).json({ error: 'Již odevzdáno' });
  db.prepare('UPDATE topic_assignments SET submitted_at = datetime("now") WHERE topic_id = ? AND student_id = ?').run(topicId, userId);
  db.prepare('UPDATE users SET xp = xp + 15 WHERE id = ?').run(userId);
  checkAndAwardBadges(userId);
  const user = db.prepare('SELECT xp FROM users WHERE id = ?').get(userId);
  res.json({ ok: true, submittedAt: new Date().toISOString(), xp: user.xp });
});

// --- TOPIC TEMPLATES ---
app.get('/api/templates', auth, (req, res) => {
  res.json(TOPIC_TEMPLATES);
});

// --- STUDENTS ---
app.get('/api/students', auth, (req, res) => {
  const students = db.prepare("SELECT id, name, username, xp, streak FROM users WHERE role = 'student'").all();
  res.json(students);
});

// --- CHAT ---
app.get('/api/chat/:topicId', auth, (req, res) => {
  const userId = req.user.id;
  const topicId = Number(req.params.topicId);

  let msgs = db.prepare('SELECT id, role, content, timestamp FROM messages WHERE user_id = ? AND topic_id = ? ORDER BY id').all(userId, topicId);

  // Pokud je konverzace prázdná, vytvoř úvodní zprávu od Káma (lektor) a ulož ji
  if (msgs.length === 0) {
    const intro = `Ahoj! Jsem Kámo, tvůj česky mluvící lektor. Budu se ptát a pomáhat ti zlepšit češtinu. Napiš mi, jak se máš, nebo co právě děláš. Prosím odpovídej CELÝMI větami.`;
    db.prepare('INSERT INTO messages (user_id, topic_id, role, content) VALUES (?, ?, ?, ?)').run(userId, topicId, 'assistant', intro);
    msgs = db.prepare('SELECT id, role, content, timestamp FROM messages WHERE user_id = ? AND topic_id = ? ORDER BY id').all(userId, topicId);
  }

  res.json(msgs);
});

app.get('/api/chat/:topicId/student/:studentId', auth, (req, res) => {
  const msgs = db.prepare('SELECT role, content, timestamp FROM messages WHERE user_id = ? AND topic_id = ? ORDER BY id').all(req.params.studentId, req.params.topicId);
  res.json(msgs);
});

app.post('/api/chat/:topicId', auth, async (req, res) => {
  const { message } = req.body;
  const userId = req.user.id;
  const topicId = Number(req.params.topicId);
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  if (!topic) return res.status(404).json({ error: 'Téma nenalezeno' });

  // Save user message
  db.prepare('INSERT INTO messages (user_id, topic_id, role, content) VALUES (?, ?, ?, ?)').run(userId, topicId, 'user', message);

  // Update streak & XP
  updateStreak(userId);
  db.prepare('UPDATE users SET xp = xp + 5 WHERE id = ?').run(userId);

  // Load history
  const history = db.prepare('SELECT role, content FROM messages WHERE user_id = ? AND topic_id = ? ORDER BY id').all(userId, topicId);
  const userMsgCount = history.filter(m => m.role === 'user').length;
  const minMessages = topic.min_messages || 10;
  const remaining = Math.max(0, minMessages - userMsgCount);

  const levelDesc = { A1: 'úplný začátečník', A2: 'mírně pokročilý', B1: 'středně pokročilý', B2: 'pokročilý', C1: 'velmi pokročilý' };
  const levelGuidelines = {
    A1: 'Používej velmi jednoduché věty (max. 4-6 slov), základní slovní zásobu, především přítomný čas, a vysvětluj nová slova příklady.',
    A2: 'Používej jednoduché až mírně složité věty, vysvětluj novou slovní zásobu v kontextu a dej příklady.',
    B1: 'Používej přirozenou, plynulou řeč s občasnou strečovou větou; vysvětli složitější výrazy a nabídni alternativy.',
    B2: 'Používej pokročilé větné struktury, spojky, podmínkové věty a idiomy; ptej se na detaily i abstraktní témata.',
    C1: 'Používej bohatý slovník, složité větné konstrukce a idiomy; pokládej otevřené otázky a diskutuj nuance.'
  };

  const systemPrompt = `Jsi přátelský lektor českého jazyka. Tvé jméno je Kámo. Vedeš konverzaci se studentem na téma: "${topic.title}" (${topic.description}).
Úroveň studenta: ${topic.level} (${levelDesc[topic.level] || 'mírně pokročilý'}).
Styl odpovědí: ${levelGuidelines[topic.level] || levelGuidelines.A2}
Student odeslal ${userMsgCount} z ${minMessages} zpráv. ${remaining <= 3 && remaining > 0 ? 'Konverzace se blíží ke konci!' : ''}

Pravidla:
- Komunikuj POUZE česky
- Přizpůsob složitost jazyka úrovni ${topic.level} (viz výše)
- Pokud student udělá gramatickou chybu, jemně ho oprav a vysvětli proč
- Ptej se vždy jen jednu otázku v každé odpovědi a rozhodně se neptat na ano/ne. Pokud věta přirozeně vyznívá jako ano/ne otázka, přetvoř ji na otevřenou otázku vyžadující delší odpověď.
- Buď povzbudivý a trpělivý
- Pokud student píše v jiném jazyce, odpověz česky a povzbuď ho aby psal česky
- Odpovídej stručně (2-4 věty), aby konverzace byla přirozená
- Vždy pobízej studenta, aby odpovídal CELÝMI VĚTAMI. Pokud student odpoví jen jedním slovem nebo krátkou frází, pochval ho za snahu, ale požádej ho, aby to řekl celou větou. Například: "Výborně! Zkus to teď říct celou větou."
- Pokud studentovi zbývá málo zpráv do konce, upozorni ho: "Blížíme se ke konci, zkus shrnout, co ses naučil/a."`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
  ];

  try {
    const completion = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages });
    const aiMessage = completion.choices[0].message.content;

    db.prepare('INSERT INTO messages (user_id, topic_id, role, content) VALUES (?, ?, ?, ?)').run(userId, topicId, 'assistant', aiMessage);
    db.prepare('UPDATE users SET xp = xp + 3 WHERE id = ?').run(userId);

    const newBadges = checkAndAwardBadges(userId);
    const user = db.prepare('SELECT xp, streak FROM users WHERE id = ?').get(userId);

    res.json({ reply: aiMessage, xp: user.xp, streak: user.streak, newBadges: newBadges.map(k => BADGE_DEFS[k]), messageCount: userMsgCount, minMessages });
  } catch (err) {
    console.error('OpenAI error:', err.message);
    res.status(500).json({ error: 'Chyba při komunikaci s AI: ' + err.message });
  }
});

// --- CONVERSATION EVALUATION ---
app.post('/api/chat/:topicId/evaluate', auth, async (req, res) => {
  const userId = req.body.studentId || req.user.id;
  const topicId = req.params.topicId;
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  const history = db.prepare('SELECT role, content FROM messages WHERE user_id = ? AND topic_id = ? ORDER BY id').all(userId, topicId);

  if (history.length < 2) return res.status(400).json({ error: 'Příliš málo zpráv pro hodnocení' });

  const evalPrompt = `Jsi odborník na hodnocení studentů českého jazyka. Zhodnoť následující konverzaci studenta (úroveň ${topic.level}) na téma "${topic.title}".

Konverzace:
${history.map(m => `${m.role === 'user' ? 'Student' : 'Lektor'}: ${m.content}`).join('\n')}

Vytvoř hodnocení v tomto formátu (česky):
- score: číslo 1-10 (1=nejhorší, 10=nejlepší)
- grade: školní známka 1-5 (1=nejlepší, 5=nejhorší)
- evaluation: souhrn hodnocení (1-2 odstavce)
- strengths: silné stránky
- improvements: oblasti ke zlepšení

Odpověď ulož jako čistý JSON (žádný jiný text).`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: evalPrompt }],
    });

    const raw = completion.choices[0].message.content;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          parsed = null;
        }
      }
    }

    const score = parsed?.score != null ? Number(parsed.score) : null;
    const grade = parsed?.grade || null;
    const evaluationText = parsed?.evaluation || raw;

    // Store evaluation record
    db.prepare(
      'INSERT INTO evaluations (topic_id, student_id, score, grade, evaluation) VALUES (?, ?, ?, ?, ?)'
    ).run(topicId, userId, score, grade, evaluationText);

    // Award bonus XP for completing evaluation
    db.prepare('UPDATE users SET xp = xp + 20 WHERE id = ?').run(userId);

    res.json({ evaluation: evaluationText, score, grade });
  } catch (err) {
    console.error('Evaluation error:', err.message);
    res.status(500).json({ error: 'Chyba při hodnocení: ' + err.message });
  }
});

// --- VOCABULARY ---
app.get('/api/vocabulary', auth, (req, res) => {
  const words = db.prepare('SELECT * FROM vocabulary WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(words);
});

app.post('/api/vocabulary', auth, (req, res) => {
  const { word, translation, contextSentence } = req.body;
  const result = db.prepare('INSERT INTO vocabulary (user_id, word, translation, context_sentence) VALUES (?, ?, ?, ?)').run(req.user.id, word, translation || '', contextSentence || '');
  checkAndAwardBadges(req.user.id);
  res.status(201).json({ id: result.lastInsertRowid, word, translation, context_sentence: contextSentence });
});

app.delete('/api/vocabulary/:id', auth, (req, res) => {
  db.prepare('DELETE FROM vocabulary WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// --- GAMIFICATION ---
app.get('/api/gamification', auth, (req, res) => {
  const user = db.prepare('SELECT xp, streak FROM users WHERE id = ?').get(req.user.id);
  const badgeRows = db.prepare('SELECT badge_key, earned_at FROM badges WHERE user_id = ?').all(req.user.id);
  const badges = badgeRows.map(b => ({ ...BADGE_DEFS[b.badge_key], key: b.badge_key, earned_at: b.earned_at }));
  const allBadges = Object.entries(BADGE_DEFS).map(([key, def]) => ({
    ...def, key, earned: badgeRows.some(b => b.badge_key === key),
  }));
  res.json({ xp: user.xp, streak: user.streak, badges, allBadges });
});

// --- STATISTICS (for teacher) ---
app.get('/api/stats', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup odepřen' });

  const students = db.prepare("SELECT id, name, username, xp, streak FROM users WHERE role = 'student'").all();
  const stats = students.map(s => {
    const msgCount = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE user_id = ? AND role = 'user'").get(s.id).cnt;
    const aiMsgCount = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE user_id = ? AND role = 'assistant'").get(s.id).cnt;
    const topicCount = db.prepare("SELECT COUNT(DISTINCT topic_id) as cnt FROM messages WHERE user_id = ? AND role = 'user'").get(s.id).cnt;
    const vocabCount = db.prepare('SELECT COUNT(*) as cnt FROM vocabulary WHERE user_id = ?').get(s.id).cnt;
    const badgeCount = db.prepare('SELECT COUNT(*) as cnt FROM badges WHERE user_id = ?').get(s.id).cnt;
    return { ...s, msgCount, aiMsgCount, topicCount, vocabCount, badgeCount };
  });
  res.json(stats);
});

// --- CHAT EVALUATION ---
app.get('/api/chat/:topicId/evaluation', auth, (req, res) => {
  const topicId = Number(req.params.topicId);
  const studentId = req.query.studentId ? Number(req.query.studentId) : req.user.id;
  const evaluation = db
    .prepare('SELECT * FROM evaluations WHERE topic_id = ? AND student_id = ? ORDER BY id DESC LIMIT 1')
    .get(topicId, studentId);
  if (!evaluation) return res.json({ evaluation: null });
  res.json({
    evaluation: evaluation.evaluation,
    score: evaluation.score,
    grade: evaluation.grade,
    created_at: evaluation.created_at,
  });
});

// --- CHAT EXPORT ---
app.get('/api/chat/:topicId/export', auth, (req, res) => {
  const studentId = req.query.studentId || req.user.id;
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(req.params.topicId);
  if (!topic) return res.status(404).json({ error: 'Téma nenalezeno' });
  const msgs = db.prepare('SELECT role, content, timestamp FROM messages WHERE user_id = ? AND topic_id = ? ORDER BY id').all(studentId, req.params.topicId);
  const student = db.prepare('SELECT name FROM users WHERE id = ?').get(studentId);

  let text = `Czech Tutor - Export konverzace\n`;
  text += `================================\n`;
  text += `Téma: ${topic.title}\n`;
  text += `Popis: ${topic.description}\n`;
  text += `Úroveň: ${topic.level}\n`;
  text += `Student: ${student?.name || 'Neznámý'}\n`;
  text += `Datum exportu: ${new Date().toLocaleString('cs-CZ')}\n`;
  text += `Počet zpráv: ${msgs.length}\n`;
  text += `================================\n\n`;

  for (const msg of msgs) {
    const who = msg.role === 'user' ? '🧑‍🎓 Student' : '🤖 Lektor';
    const time = new Date(msg.timestamp).toLocaleString('cs-CZ');
    text += `[${time}] ${who}:\n${msg.content}\n\n`;
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="chat-${topic.title.replace(/\s+/g, '-')}.txt"`);
  res.send(text);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Czech Tutor API běží na portu ${PORT}`));
