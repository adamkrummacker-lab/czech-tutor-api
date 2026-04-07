require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0) return cb(null, true);
    return cb(null, allowedOrigins.includes(origin));
  },
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
// app.options('*') nepracuje se starší dráhou path-to-regexp, křížově vynecháme a používáme globální CORS middleware
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const JWT_SECRET = process.env.JWT_SECRET || 'czech-tutor-secret-key-2026';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// Sequelize podpora (Postgres/SQLite) - step 1 (perzistence pro budoucí produkci)
const { sequelize } = require('./db');

sequelize.authenticate().then(() => {
  console.log('Sequelize connection OK');
}).catch(err => {
  console.warn('Sequelize connection error:', err.message);
});

sequelize.sync({ alter: true }).then(() => {
  console.log('Sequelize sync complete');
}).catch(err => {
  console.error('Sequelize sync failed:', err.message);
});

function generateJoinCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function generatePassword(length = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let password = '';
  for (let i = 0; i < length; i++) password += chars[Math.floor(Math.random() * chars.length)];
  return password;
}

function ensureTeacherClass(teacherId, teacherName) {
  const existing = db.prepare('SELECT id FROM classes WHERE teacher_id = ?').get(teacherId);
  if (existing) return;
  const joinCode = generateJoinCode();
  db.prepare('INSERT INTO classes (name, teacher_id, join_code) VALUES (?, ?, ?)').run(`${teacherName} - Třída`, teacherId, joinCode);
  console.log(`Created class for teacher ${teacherName} (code: ${joinCode})`);
}

// --- DATABASE SETUP ---
const db = new Database(path.join(__dirname, 'czech-tutor.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const clearDataOnStart = () => {
  if (process.env.CLEAR_CLASSES === 'true') {
    console.log('CLEAR_CLASSES enabled: vymazávám třídy a přiřazení...')
    db.prepare('UPDATE users SET class_id = NULL').run()
    db.prepare('DELETE FROM topic_assignments').run()
    db.prepare('DELETE FROM classes').run()
  }
}

clearDataOnStart()

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
  CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    join_code TEXT UNIQUE NOT NULL,
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
  CREATE TABLE IF NOT EXISTS class_topic_assignments (
    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (class_id, topic_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    emoji TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(message_id, user_id, emoji)
  );
  CREATE TABLE IF NOT EXISTS vocabulary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    word TEXT NOT NULL,
    translation TEXT,
    context_sentence TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ai_instructions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    instructions TEXT NOT NULL,
    is_global BOOLEAN DEFAULT FALSE,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS lectures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS lecture_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    lecture_id INTEGER REFERENCES lectures(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
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
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES users(id),
    rating INTEGER NOT NULL,
    text TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Ensure preferences + class_id columns exist (JSON blob + class membership)
const userColumns = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
if (!userColumns.includes('preferences')) {
  db.prepare("ALTER TABLE users ADD COLUMN preferences TEXT DEFAULT '{}' ").run();
}
if (!userColumns.includes('class_id')) {
  db.prepare("ALTER TABLE users ADD COLUMN class_id INTEGER").run();
}
if (!userColumns.includes('email')) {
  db.prepare("ALTER TABLE users ADD COLUMN email TEXT").run();
}
db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)').run();

const evaluationColumns = db.prepare("PRAGMA table_info(evaluations)").all().map(r => r.name);
if (!evaluationColumns.includes('quiz_score')) {
  db.prepare("ALTER TABLE evaluations ADD COLUMN quiz_score INTEGER").run();
}
if (!evaluationColumns.includes('quiz_total')) {
  db.prepare("ALTER TABLE evaluations ADD COLUMN quiz_total INTEGER").run();
}

// Seed default users if empty
const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
if (userCount === 0) {
  const hash1 = bcrypt.hashSync('ucitel123', 10);
  const hash2 = bcrypt.hashSync('zak123', 10);
  const adminHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare('INSERT INTO users (username, password, role, name) VALUES (?, ?, ?, ?)').run('ucitel', hash1, 'teacher', 'Učitel');
  db.prepare('INSERT INTO users (username, password, role, name) VALUES (?, ?, ?, ?)').run('zak', hash2, 'student', 'Žák Adam');
  db.prepare('INSERT INTO users (username, password, role, name) VALUES (?, ?, ?, ?)').run(ADMIN_USERNAME, adminHash, 'admin', 'Admin');
  console.log('Default users created');

  // Create a default class for the teacher and add the default student into it
  const teacher = db.prepare('SELECT * FROM users WHERE username = ?').get('ucitel');
  const student = db.prepare('SELECT * FROM users WHERE username = ?').get('zak');
  if (teacher && student) {
    const existing = db.prepare('SELECT * FROM classes WHERE teacher_id = ?').get(teacher.id);
    if (!existing) {
      const joinCode = generateJoinCode();
      const classResult = db.prepare('INSERT INTO classes (name, teacher_id, join_code) VALUES (?, ?, ?)').run('1.A - Třída', teacher.id, joinCode);
      db.prepare('UPDATE users SET class_id = ? WHERE id = ?').run(classResult.lastInsertRowid, student.id);
      console.log('Default class created (code:', joinCode, ')');
    }
  }
}

// Ensure admin user exists
const adminByUsername = db.prepare('SELECT id, username FROM users WHERE username = ?').get(ADMIN_USERNAME);
if (!adminByUsername) {
  const adminHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare('INSERT INTO users (username, password, role, name) VALUES (?, ?, ?, ?)').run(ADMIN_USERNAME, adminHash, 'admin', 'Admin');
  console.log('Admin user created');
} else if (process.env.ADMIN_FORCE_RESET === 'true') {
  const adminHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare('UPDATE users SET password = ?, role = ?, name = ? WHERE username = ?')
    .run(adminHash, 'admin', 'Admin', ADMIN_USERNAME);
  console.log('Admin password reset from env');
}

// Ensure every teacher has at least one class (so students can join)
const teachers = db.prepare("SELECT * FROM users WHERE role = 'teacher'").all();
for (const t of teachers) {
  ensureTeacherClass(t.id, t.name);
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
  'Dnešní tip: Zkus používat slovesa v přítomném čase v celých větách.',
  'Tip dne: Když nevíš slovo, popiš ho jinak – například místo „auto“ můžeš říct „vozidlo“.',
  'Tip dne: Nejistě se cítíš? Zopakuj si minulý příběh v několika větách.',
  'Tip dne: Zkus v odpovědi použít slovo „protože“ nebo „když“.',
  'Tip dne: Napiš alespoň dvě věty (nejen jedno slovo).'
];

const BADGE_DEFS = {
  first_message: { name: 'První zpráva', emoji: '🎯', desc: 'Poslal/a jsi první zprávu' },
  messages_10: { name: 'Konverzátor', emoji: '💬', desc: '10 zpráv odesláno' },
  messages_50: { name: 'Řečník', emoji: '🗣️', desc: '50 zpráv odesláno' },
  messages_100: { name: 'Mistr slova', emoji: '📚', desc: '100 zpráv odesláno' },
  topics_3: { name: 'Průzkumník', emoji: '🧭', desc: '3 témata vyzkoušena' },
  topics_5: { name: 'Polyglot', emoji: '🌍', desc: '5 témat vyzkoušena' },
  streak_3: { name: 'Na vlně', emoji: '🔥', desc: '3 dny v řadě' },
  streak_7: { name: 'Vytrvalý', emoji: '⚡', desc: '7 dní v řadě' },
  vocab_10: { name: 'Sběratel slov', emoji: '📖', desc: '10 slov ve slovníčku' },
  xp_100: { name: 'Začátečník', emoji: '⭐', desc: '100 XP nasbíráno' },
  xp_500: { name: 'Pokročilý', emoji: '🏆', desc: '500 XP nasbíráno' },
};

// --- BADGE DEFINITIONS ---
function checkAndAwardBadges(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return; // User might have been deleted; don't crash the badge endpoint

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

function requireTeacher(req, res, next) {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Přístup zamítnut' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Přístup zamítnut' });
  }
  next();
}

function requireStudent(req, res, next) {
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Přístup zamítnut' });
  }
  next();
}

function logAudit(userId, action, targetType = null, targetId = null, metadata = null) {
  try {
    db.prepare(
      'INSERT INTO audit_logs (user_id, action, target_type, target_id, metadata) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, action, targetType, targetId, metadata ? JSON.stringify(metadata) : null);
  } catch (err) {
    console.warn('Audit log failed:', err.message);
  }
}

function teacherOwnsTopic(teacherId, topicId) {
  const row = db.prepare('SELECT id FROM topics WHERE id = ? AND created_by = ?').get(topicId, teacherId);
  return !!row;
}

function teacherOwnsStudent(teacherId, studentId) {
  const row = db.prepare(
    `SELECT u.id
     FROM users u
     JOIN classes c ON c.id = u.class_id
     WHERE u.id = ? AND c.teacher_id = ?`
  ).get(studentId, teacherId);
  return !!row;
}

function studentAssignedToTopic(studentId, topicId) {
  const row = db.prepare(
    'SELECT topic_id FROM topic_assignments WHERE topic_id = ? AND student_id = ?'
  ).get(topicId, studentId);
  return !!row;
}

// --- AUTH ROUTES ---
app.get('/api/auth/login', (req, res) => {
  res.status(405).json({ error: 'Use POST for /api/auth/login', method: 'POST' });
});

app.get('/api/auth/register', (req, res) => {
  res.status(405).json({ error: 'Use POST for /api/auth/register', method: 'POST' });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const identifier = (username || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(identifier, identifier);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Špatné přihlašovací údaje' });
  }
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  let preferences = {};
  try { preferences = user.preferences ? JSON.parse(user.preferences) : {}; } catch {}
  res.json({ id: user.id, username: user.username, role: user.role, name: user.name, preferences, token });
});

app.post('/api/auth/register', (req, res) => {
  const { username, password, name, classCode, email } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'Vyplň všechna pole' });
  if (username.length < 3) return res.status(400).json({ error: 'Uživatelské jméno musí mít min. 3 znaky' });
  if (password.length < 4) return res.status(400).json({ error: 'Heslo musí mít min. 4 znaky' });

  const normalizedUsername = username.trim().toLowerCase();
  const normalizedEmail = email ? email.trim().toLowerCase() : null;
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(normalizedUsername);
  if (existing) return res.status(409).json({ error: 'Uživatelské jméno je obsazené' });
  if (normalizedEmail) {
    if (!normalizedEmail.includes('@')) return res.status(400).json({ error: 'Neplatný email' });
    const emailTaken = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (emailTaken) return res.status(409).json({ error: 'Email je už použitý' });
  }

  let classId = null;
  let classInfo = null;
  if (classCode) {
    const cls = db.prepare('SELECT * FROM classes WHERE join_code = ?').get(classCode.trim().toUpperCase());
    if (!cls) return res.status(404).json({ error: 'Třída nenalezena' });
    classId = cls.id;
    classInfo = cls;
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password, role, name, class_id, email) VALUES (?, ?, ?, ?, ?, ?)').run(normalizedUsername, hash, 'student', name, classId, normalizedEmail);
  const token = jwt.sign({ id: result.lastInsertRowid, role: 'student' }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ id: result.lastInsertRowid, username: normalizedUsername, role: 'student', name, token, preferences: {}, class: classInfo });
});

// --- ADMIN: TEACHER MANAGEMENT ---
app.get('/api/admin/teachers', auth, requireAdmin, (req, res) => {
  const teachers = db.prepare(
    `SELECT u.id, u.username, u.name, u.email, u.created_at,
            (SELECT COUNT(*) FROM classes c WHERE c.teacher_id = u.id) AS class_count,
            (SELECT COUNT(*) FROM users s WHERE s.role = 'student' AND s.class_id IN (SELECT id FROM classes c2 WHERE c2.teacher_id = u.id)) AS student_count
     FROM users u
     WHERE u.role = 'teacher'
     ORDER BY u.created_at DESC`
  ).all();
  res.json({ teachers });
});

app.post('/api/admin/teachers', auth, requireAdmin, (req, res) => {
  const { username, password, name, email } = req.body || {};
  if (!username || !name) {
    return res.status(400).json({ error: 'Chybí username nebo jméno' });
  }
  const normalizedUsername = username.trim().toLowerCase();
  const normalizedEmail = email ? email.trim().toLowerCase() : null;
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(normalizedUsername);
  if (existing) return res.status(409).json({ error: 'Uživatel už existuje' });
  if (normalizedEmail) {
    if (!normalizedEmail.includes('@')) return res.status(400).json({ error: 'Neplatný email' });
    const emailTaken = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (emailTaken) return res.status(409).json({ error: 'Email je už použitý' });
  }

  const finalPassword = password?.trim() || generatePassword();
  const hash = bcrypt.hashSync(finalPassword, 10);
  const result = db.prepare('INSERT INTO users (username, password, role, name, email) VALUES (?, ?, ?, ?, ?)').run(normalizedUsername, hash, 'teacher', name.trim(), normalizedEmail);
  ensureTeacherClass(result.lastInsertRowid, name.trim());
  logAudit(req.user.id, 'admin_create_teacher', 'user', result.lastInsertRowid, { username: normalizedUsername, name, email: normalizedEmail });
  res.status(201).json({ id: result.lastInsertRowid, username: normalizedUsername, name: name.trim(), email: normalizedEmail, password: password ? null : finalPassword });
});

app.delete('/api/admin/teachers/:id', auth, requireAdmin, (req, res) => {
  const teacherId = Number(req.params.id);
  const teacher = db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'teacher'").get(teacherId);
  if (!teacher) return res.status(404).json({ error: 'Učitel nenalezen' });

  const classIds = db.prepare('SELECT id FROM classes WHERE teacher_id = ?').all(teacherId).map(r => r.id);
  if (classIds.length > 0) {
    const placeholders = classIds.map(() => '?').join(',');
    db.prepare(`UPDATE users SET class_id = NULL WHERE class_id IN (${placeholders})`).run(...classIds);
    db.prepare(`DELETE FROM classes WHERE id IN (${placeholders})`).run(...classIds);
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(teacherId);
  logAudit(req.user.id, 'admin_delete_teacher', 'user', teacherId, { name: teacher.name });
  res.json({ ok: true });
});


// --- USER PREFERENCES ---
app.get('/api/me/preferences', auth, (req, res) => {
  const user = db.prepare('SELECT preferences FROM users WHERE id = ?').get(req.user.id);
  let preferences = {};
  try { preferences = user?.preferences ? JSON.parse(user.preferences) : {}; } catch {}
  res.json(preferences);
});

app.put('/api/me/preferences', auth, (req, res) => {
  const existing = db.prepare('SELECT preferences FROM users WHERE id = ?').get(req.user.id);
  let preferences = {};
  try { preferences = existing?.preferences ? JSON.parse(existing.preferences) : {}; } catch {}
  const updated = { ...preferences, ...req.body };
  db.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(updated), req.user.id);
  res.json(updated);
});

// --- TOPICS ---
app.get('/api/topics', auth, (req, res) => {
  if (req.user.role === 'teacher') {
    const topics = db.prepare('SELECT * FROM topics WHERE created_by = ? ORDER BY created_at DESC').all(req.user.id);
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
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });
  const { title, description, level, minMessages } = req.body;
  const result = db.prepare('INSERT INTO topics (title, description, level, min_messages, created_by) VALUES (?, ?, ?, ?, ?)').run(title, description || '', level || 'A2', minMessages || 10, req.user.id);
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(result.lastInsertRowid);
  topic.assignedTo = [];
  logAudit(req.user.id, 'topic_create', 'topic', topic.id, { title: topic.title });
  res.status(201).json(topic);
});

app.delete('/api/topics/:id', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });
  if (!teacherOwnsTopic(req.user.id, req.params.id)) {
    return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
  }
  const result = db.prepare('DELETE FROM topics WHERE id = ? AND created_by = ?').run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Téma nenalezeno' });
  logAudit(req.user.id, 'topic_delete', 'topic', Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/topics/:id/assign', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });
  const { studentId } = req.body;
  if (!teacherOwnsTopic(req.user.id, req.params.id)) {
    return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
  }
  if (!teacherOwnsStudent(req.user.id, studentId)) {
    return res.status(403).json({ error: 'Student nepatří do vaší třídy' });
  }
  const student = db.prepare('SELECT role FROM users WHERE id = ?').get(studentId);
  if (!student || student.role !== 'student') {
    return res.status(400).json({ error: 'Neplatný student' });
  }
  db.prepare('INSERT OR IGNORE INTO topic_assignments (topic_id, student_id) VALUES (?, ?)').run(req.params.id, studentId);
  const topic = db.prepare('SELECT * FROM topics WHERE id = ? AND created_by = ?').get(req.params.id, req.user.id);
  if (!topic) return res.status(404).json({ error: 'Téma nenalezeno' });
  topic.assignedTo = db.prepare('SELECT student_id FROM topic_assignments WHERE topic_id = ?').all(topic.id).map(r => r.student_id);
  logAudit(req.user.id, 'topic_assign', 'topic', topic.id, { studentId });
  res.json(topic);
});

app.post('/api/topics/:id/assign-class', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });
  const { classId } = req.body;
  const topicId = Number(req.params.id);
  const parsedClassId = Number(classId);
  if (Number.isNaN(topicId) || Number.isNaN(parsedClassId)) {
    return res.status(400).json({ error: 'Neplatné ID' });
  }
  if (!teacherOwnsTopic(req.user.id, topicId)) {
    return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
  }
  const cls = db.prepare('SELECT id FROM classes WHERE id = ? AND teacher_id = ?').get(parsedClassId, req.user.id);
  if (!cls) return res.status(404).json({ error: 'Třída nenalezena' });

  db.prepare('INSERT OR IGNORE INTO class_topic_assignments (class_id, topic_id) VALUES (?, ?)').run(parsedClassId, topicId);
  const students = db.prepare('SELECT id FROM users WHERE class_id = ? AND role = ?').all(parsedClassId, 'student');
  for (const student of students) {
    db.prepare('INSERT OR IGNORE INTO topic_assignments (topic_id, student_id) VALUES (?, ?)').run(topicId, student.id);
  }

  logAudit(req.user.id, 'topic_assign_class', 'topic', topicId, { classId: parsedClassId, assigned: students.length });
  res.json({ ok: true, assigned: students.length });
});

app.post('/api/topics/:id/unassign-class', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });
  const { classId } = req.body;
  const topicId = Number(req.params.id);
  const parsedClassId = Number(classId);
  if (Number.isNaN(topicId) || Number.isNaN(parsedClassId)) {
    return res.status(400).json({ error: 'Neplatné ID' });
  }
  if (!teacherOwnsTopic(req.user.id, topicId)) {
    return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
  }
  const cls = db.prepare('SELECT id FROM classes WHERE id = ? AND teacher_id = ?').get(parsedClassId, req.user.id);
  if (!cls) return res.status(404).json({ error: 'Třída nenalezena' });

  const result = db.prepare(`
    DELETE FROM topic_assignments
    WHERE topic_id = ?
      AND student_id IN (SELECT id FROM users WHERE class_id = ? AND role = 'student')
  `).run(topicId, parsedClassId);
  db.prepare('DELETE FROM class_topic_assignments WHERE topic_id = ? AND class_id = ?').run(topicId, parsedClassId);

  logAudit(req.user.id, 'topic_unassign_class', 'topic', topicId, { classId: parsedClassId, removed: result.changes });
  res.json({ ok: true, removed: result.changes });
});

// --- SUBMIT WORK ---
app.post('/api/topics/:topicId/submit', auth, (req, res) => {
  try {
    const topicId = Number(req.params.topicId);
    if (Number.isNaN(topicId)) {
      return res.status(400).json({ error: 'Neplatné ID tématu' });
    }

    const userId = req.user.id;
    if (req.user.role !== 'student') {
      return res.status(403).json({ error: 'Pouze studenti mohou odevzdávat' });
    }

    if (!studentAssignedToTopic(userId, topicId)) {
      return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
    }
    const assignment = db.prepare('SELECT * FROM topic_assignments WHERE topic_id = ? AND student_id = ?').get(topicId, userId);
    if (!assignment) return res.status(404).json({ error: 'Přiřazení nenalezeno' });
    if (assignment.submitted_at) return res.status(400).json({ error: 'Již odevzdáno' });

    db.prepare('UPDATE topic_assignments SET submitted_at = datetime(\'now\') WHERE topic_id = ? AND student_id = ?').run(topicId, userId);
    db.prepare('UPDATE users SET xp = xp + 15 WHERE id = ?').run(userId);
    checkAndAwardBadges(userId);

    const user = db.prepare('SELECT xp FROM users WHERE id = ?').get(userId);
    logAudit(userId, 'topic_submit', 'topic', topicId);
    res.json({ ok: true, submittedAt: new Date().toISOString(), xp: user.xp });
  } catch (err) {
    console.error('Submit work error', err);
    res.status(500).json({ error: err.message || 'Chyba serveru při odevzdávání. Zkus to prosím později.', stack: err.stack });
  }
});

// --- TOPIC TEMPLATES ---
app.get('/api/templates', auth, (req, res) => {
  res.json(TOPIC_TEMPLATES);
});

app.post('/api/templates/generate', auth, async (req, res) => {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Přístup zamítnut' });
  }
  const level = (req.body?.level || 'A2').toString().toUpperCase();
  const allowedLevels = new Set(['A1', 'A2', 'B1', 'B2', 'C1']);
  const safeLevel = allowedLevels.has(level) ? level : 'A2';
  const requestedCount = Number(req.body?.count) || 1;
  const count = Math.max(1, Math.min(10, requestedCount));

  const prompt = `Vygeneruj ${count} nové konverzační téma pro výuku češtiny.
Úroveň: ${safeLevel}.
Požadavky:
- Výstup jako čistý JSON
- Pokud je více témat, vrať pole objektů
- Klíče: title, description, level, minMessages
- title: krátký název (max 6 slov)
- description: 1-2 věty s konkrétní situací a otázkou
- level: "${safeLevel}"
- minMessages: číslo 8-12
Neuváděj žádný další text.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    });
    const raw = completion.choices[0].message.content || '';
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          parsed = null;
        }
      }
    }
    const items = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    const cleaned = items
      .map(item => ({
        title: String(item?.title || '').trim(),
        description: String(item?.description || '').trim(),
        level: safeLevel,
        minMessages: Number(item?.minMessages) || 10,
      }))
      .filter(item => item.title && item.description);

    if (cleaned.length === 0) {
      return res.status(500).json({ error: 'AI nevygenerovala platnou šablonu' });
    }

    res.json({ items: cleaned });
  } catch (err) {
    console.error('Template generation error:', err.message);
    res.status(500).json({ error: 'Chyba při generování šablony' });
  }
});

app.get('/api/daily-tip', auth, (req, res) => {
  const today = new Date();
  const idx = today.getDate() + today.getMonth() * 31;
  const tip = DAILY_TIPS[idx % DAILY_TIPS.length];
  res.json({ tip });
});

// --- GLOBAL ERROR HANDLING ---
app.use((err, req, res, next) => {
  console.error('Unhandled server error', err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: 'Internal server error (podrobnosti v logu)' });
});

// --- AI INSTRUCTIONS ---
app.get('/api/ai-instructions', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });

  const { topicId } = req.query;
  let instructions;
  
  if (topicId) {
    // Get specific topic instructions
    instructions = db.prepare(`
      SELECT ai.*, t.title as topic_title 
      FROM ai_instructions ai
      LEFT JOIN topics t ON ai.topic_id = t.id
      WHERE ai.teacher_id = ? AND ai.topic_id = ?
    `).get(req.user.id, topicId);
  } else {
    // Get all instructions for this teacher
    instructions = db.prepare(`
      SELECT ai.*, t.title as topic_title 
      FROM ai_instructions ai
      LEFT JOIN topics t ON ai.topic_id = t.id
      WHERE ai.teacher_id = ?
      ORDER BY ai.is_global DESC, ai.updated_at DESC
    `).all(req.user.id);
  }
  
  res.json(instructions);
});

app.post('/api/ai-instructions', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });

  const { topicId, instructions, isGlobal } = req.body;
  const isGlobalFlag = isGlobal ? 1 : 0;
  const normalizedTopicId = isGlobalFlag ? null : (topicId || null);
  
  if (!instructions || !instructions.trim()) {
    return res.status(400).json({ error: 'Instrukce nemohou být prázdné' });
  }

  try {
    const result = db.prepare(`
      INSERT INTO ai_instructions 
      (teacher_id, topic_id, instructions, is_global, updated_at) 
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(
      req.user.id,
      normalizedTopicId,
      instructions.trim(),
      isGlobalFlag
    );

    res.json({ 
      id: result.lastInsertRowid,
      message: 'AI instrukce uloženy' 
    });
  } catch (err) {
    console.error('AI instructions save error:', err);
    res.status(500).json({ error: 'Chyba při ukládání instrukcí' });
  }
});

app.put('/api/ai-instructions/:id', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });

  const { id } = req.params;
  const { instructions, isGlobal, topicId } = req.body;
  const isGlobalFlag = isGlobal ? 1 : 0;

  if (!instructions || !instructions.trim()) {
    return res.status(400).json({ error: 'Instrukce nemohou být prázdné' });
  }

  const existing = db.prepare('SELECT id, topic_id FROM ai_instructions WHERE id = ? AND teacher_id = ?').get(id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Instrukce nenalezeny' });

  try {
    const normalizedTopicId = isGlobalFlag ? null : (topicId || existing.topic_id || null);
    db.prepare(`
      UPDATE ai_instructions 
      SET instructions = ?, is_global = ?, topic_id = ?, updated_at = datetime('now')
      WHERE id = ? AND teacher_id = ?
    `).run(
      instructions.trim(),
      isGlobalFlag,
      normalizedTopicId,
      id,
      req.user.id
    );

    res.json({ message: 'AI instrukce aktualizovány' });
  } catch (err) {
    console.error('AI instructions update error:', err);
    res.status(500).json({ error: 'Chyba při aktualizaci instrukcí' });
  }
});

app.delete('/api/ai-instructions/:id', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });

  const { id } = req.params;

  const result = db.prepare('DELETE FROM ai_instructions WHERE id = ? AND teacher_id = ?').run(id, req.user.id);
  
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Instrukce nenalezeny' });
  }

  res.json({ message: 'AI instrukce smazány' });
});

// --- STUDENTS + CLASSES ---
app.get('/api/students', auth, (req, res) => {
  // Teachers only: show students in their classes
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });

  const students = db.prepare(
    `SELECT u.id, u.name, u.username, u.xp, u.streak, u.class_id, c.name as class_name
     FROM users u
     JOIN classes c ON u.class_id = c.id
     WHERE c.teacher_id = ?`
  ).all(req.user.id);
  res.json(students);
});

app.get('/api/classes', auth, (req, res) => {
  if (req.user.role === 'teacher') {
    const classes = db.prepare('SELECT * FROM classes WHERE teacher_id = ?').all(req.user.id);
    const students = db.prepare('SELECT id, name, username, xp, streak, class_id FROM users WHERE class_id IN (SELECT id FROM classes WHERE teacher_id = ?)').all(req.user.id);
    const studentsByClass = {};
    for (const s of students) {
      studentsByClass[s.class_id] = studentsByClass[s.class_id] || [];
      studentsByClass[s.class_id].push(s);
    }
    const result = classes.map(c => ({ ...c, students: studentsByClass[c.id] || [] }));
    return res.json(result);
  }

  // Students: return their own class info
  const cls = db.prepare(
    `SELECT c.*, u.name as teacher_name
     FROM classes c
     JOIN users u ON u.id = c.teacher_id
     WHERE c.id = ?`
  ).get(req.user.class_id);
  if (!cls) return res.json(null);
  res.json(cls);
});

app.get('/api/classes/me', auth, (req, res) => {
  // Shortcut for current user
  if (req.user.role === 'teacher') {
    const classes = db.prepare('SELECT * FROM classes WHERE teacher_id = ?').all(req.user.id);
    return res.json({ role: 'teacher', classes });
  }

  const user = db.prepare('SELECT class_id FROM users WHERE id = ?').get(req.user.id);
  if (!user?.class_id) return res.json({ role: 'student' });

  const cls = db.prepare(
    `SELECT c.*, u.name as teacher_name
     FROM classes c
     JOIN users u ON u.id = c.teacher_id
     WHERE c.id = ?`
  ).get(user.class_id);
  if (!cls) return res.json({ role: 'student' });
  res.json({ role: 'student', class: cls });
});

// --- CLASS PROGRESS ---
app.get('/api/class-progress', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });
  const classes = db.prepare('SELECT id, name FROM classes WHERE teacher_id = ?').all(req.user.id);
  const progress = classes.map(c => {
    const studentCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM users WHERE class_id = ? AND role = 'student'`
    ).get(c.id).cnt;
    const assignedCount = db.prepare(
      `SELECT COUNT(*) as cnt
       FROM topic_assignments ta
       JOIN users u ON u.id = ta.student_id
       WHERE u.class_id = ?`
    ).get(c.id).cnt;
    const submittedCount = db.prepare(
      `SELECT COUNT(*) as cnt
       FROM topic_assignments ta
       JOIN users u ON u.id = ta.student_id
       WHERE u.class_id = ? AND ta.submitted_at IS NOT NULL`
    ).get(c.id).cnt;
    const topicsAssigned = db.prepare(
      `SELECT COUNT(DISTINCT ta.topic_id) as cnt
       FROM topic_assignments ta
       JOIN users u ON u.id = ta.student_id
       WHERE u.class_id = ?`
    ).get(c.id).cnt;
    return {
      classId: c.id,
      className: c.name,
      studentCount,
      assignedCount,
      submittedCount,
      topicsAssigned,
    };
  });
  res.json(progress);
});

// --- LEADERBOARD ---
app.get('/api/leaderboard', auth, (req, res) => {
  const toAchievementList = (preferencesText) => {
    let prefs = {};
    try {
      prefs = preferencesText ? JSON.parse(preferencesText) : {};
    } catch {
      prefs = {};
    }
    const keys = Array.isArray(prefs.profileBadges) ? prefs.profileBadges : [];
    return keys
      .map(key => BADGE_DEFS[key] ? ({ key, name: BADGE_DEFS[key].name, emoji: BADGE_DEFS[key].emoji }) : null)
      .filter(Boolean);
  };

  if (req.user.role === 'teacher') {
    const classId = Number(req.query.classId);
    if (!classId || Number.isNaN(classId)) {
      return res.status(400).json({ error: 'Chybí nebo je neplatné classId' });
    }
    const cls = db.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?').get(classId, req.user.id);
    if (!cls) return res.status(404).json({ error: 'Třída nenalezena' });
    const entries = db.prepare(
      `SELECT id, name, username, xp, streak, preferences
       FROM users
       WHERE class_id = ? AND role = 'student'
       ORDER BY xp DESC, streak DESC, name ASC`
    ).all(classId);
    const mapped = entries.map(e => ({
      id: e.id,
      name: e.name,
      username: e.username,
      xp: e.xp,
      streak: e.streak,
      achievements: toAchievementList(e.preferences),
    }));
    return res.json({ entries: mapped, class: { id: cls.id, name: cls.name } });
  }

  const user = db.prepare('SELECT class_id FROM users WHERE id = ?').get(req.user.id);
  if (!user?.class_id) return res.json({ entries: [], class: null });
  const cls = db.prepare('SELECT id, name FROM classes WHERE id = ?').get(user.class_id);
  const entries = db.prepare(
    `SELECT id, name, username, xp, streak, preferences
     FROM users
     WHERE class_id = ? AND role = 'student'
     ORDER BY xp DESC, streak DESC, name ASC`
  ).all(user.class_id);
  const mapped = entries.map(e => ({
    id: e.id,
    name: e.name,
    username: e.username,
    xp: e.xp,
    streak: e.streak,
    achievements: toAchievementList(e.preferences),
  }));
  res.json({ entries: mapped, class: cls });
});

app.post('/api/classes', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Název třídy je povinný' });
  const joinCode = generateJoinCode();
  const result = db.prepare('INSERT INTO classes (name, teacher_id, join_code) VALUES (?, ?, ?)').run(name.trim(), req.user.id, joinCode);
  logAudit(req.user.id, 'class_create', 'class', result.lastInsertRowid, { name: name.trim() });
  res.status(201).json({ id: result.lastInsertRowid, name: name.trim(), teacher_id: req.user.id, join_code: joinCode });
});

app.post('/api/classes/join', auth, (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Přístup zamítnut' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Kód třídy je povinný' });
  const cls = db.prepare('SELECT * FROM classes WHERE join_code = ?').get(code.trim().toUpperCase());
  if (!cls) return res.status(404).json({ error: 'Třída nenalezena' });
  db.prepare('UPDATE users SET class_id = ? WHERE id = ?').run(cls.id, req.user.id);
  const classTopics = db.prepare('SELECT topic_id FROM class_topic_assignments WHERE class_id = ?').all(cls.id);
  for (const row of classTopics) {
    db.prepare('INSERT OR IGNORE INTO topic_assignments (topic_id, student_id) VALUES (?, ?)').run(row.topic_id, req.user.id);
  }
  logAudit(req.user.id, 'class_join', 'class', cls.id);
  res.json({ class: cls });
});

app.post('/api/classes/leave', auth, (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Přístup zamítnut' });
  db.prepare('UPDATE users SET class_id = NULL WHERE id = ?').run(req.user.id);
  logAudit(req.user.id, 'class_leave', 'class', null);
  res.json({ ok: true });
});

app.delete('/api/classes/:id', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });
  const classId = Number(req.params.id);
  if (Number.isNaN(classId)) return res.status(400).json({ error: 'Neplatné ID třídy' });

  console.log('DELETE /api/classes/:id', { classId, userId: req.user.id })
  const cls = db.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?').get(classId, req.user.id);
  if (!cls) {
    console.warn('Class not found for delete', { classId, teacherId: req.user.id });
    return res.status(404).json({ error: 'Třída nenalezena' });
  }

  db.prepare('UPDATE users SET class_id = NULL WHERE class_id = ?').run(classId);
  db.prepare('DELETE FROM classes WHERE id = ? AND teacher_id = ?').run(classId, req.user.id);

  logAudit(req.user.id, 'class_delete', 'class', classId);
  res.json({ ok: true });
});

app.get('/api/version', (req, res) => {
  let commit = null
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
  } catch (err) {
    // ignore
  }
  res.json({ commit, time: new Date().toISOString() })
})

app.post('/api/students/invite', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });
  const { name, classId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Jméno žáka je povinné' });

  const cls = db.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?').get(classId, req.user.id);
  if (!cls) return res.status(404).json({ error: 'Třída nenalezena' });

  // Generate unique username
  const baseName = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '') || 'student';
  let username = baseName;
  let suffix = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    username = `${baseName}${suffix}`;
    suffix += 1;
  }

  const password = generatePassword(10);
  const hash = bcrypt.hashSync(password, 10);

  db.prepare('INSERT INTO users (username, password, role, name, class_id) VALUES (?, ?, ?, ?, ?)')
    .run(username, hash, 'student', name.trim(), cls.id);

  logAudit(req.user.id, 'student_invite', 'class', cls.id, { name: name.trim(), username });
  res.status(201).json({ username, password, classId: cls.id, className: cls.name });
});

// --- CHAT ---
app.get('/api/chat/:topicId', auth, (req, res) => {
  const userId = req.user.id;
  const topicId = Number(req.params.topicId);
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Přístup zamítnut' });
  }
  if (!studentAssignedToTopic(userId, topicId)) {
    return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
  }
  const topic = db.prepare('SELECT title, description, level FROM topics WHERE id = ?').get(topicId);
  if (!topic) return res.status(404).json({ error: 'Téma nenalezeno' });

  let msgs = db.prepare('SELECT id, role, content, timestamp FROM messages WHERE user_id = ? AND topic_id = ? ORDER BY id').all(userId, topicId);

  // Pokud je konverzace prázdná, vytvoř úvodní zprávu od Káma (lektor) a ulož ji
  if (msgs.length === 0) {
    const topicLine = topic.description ? `Téma: "${topic.title}" (${topic.description}).` : `Téma: "${topic.title}".`;
    const intro = topic.level === 'A1'
      ? `Ahoj! Jsem Kámo, tvůj lektor. ${topicLine} Napiš jednu krátkou větu k tématu. Např.: "Téma je ${topic.title}." 🙂`
      : `Ahoj! Jsem Kámo, tvůj česky mluvící lektor. ${topicLine} Začni prosím tím, že napíšeš 1–2 věty k tématu. Prosím odpovídej CELÝMI větami.`;
    db.prepare('INSERT INTO messages (user_id, topic_id, role, content) VALUES (?, ?, ?, ?)').run(userId, topicId, 'assistant', intro);
    msgs = db.prepare('SELECT id, role, content, timestamp FROM messages WHERE user_id = ? AND topic_id = ? ORDER BY id').all(userId, topicId);
  }

  // Přidej reakce k jednotlivým zprávám
  const messageIds = msgs.map(m => m.id);
  if (messageIds.length > 0) {
    const reactions = db.prepare(
      `SELECT message_id, emoji, COUNT(*) as count, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as me
       FROM message_reactions
       WHERE message_id IN (${messageIds.map(() => '?').join(',')})
       GROUP BY message_id, emoji`
    ).all(userId, ...messageIds);

    const reactionsByMessage = {};
    for (const r of reactions) {
      if (!reactionsByMessage[r.message_id]) reactionsByMessage[r.message_id] = [];
      reactionsByMessage[r.message_id].push({ emoji: r.emoji, count: r.count, me: !!r.me });
    }
    msgs = msgs.map(m => ({ ...m, reactions: reactionsByMessage[m.id] || [] }));
  }

  res.json(msgs);
});

app.get('/api/chat/:topicId/student/:studentId', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });
  const topicId = Number(req.params.topicId);
  const studentId = Number(req.params.studentId);
  if (!teacherOwnsStudent(req.user.id, studentId)) {
    return res.status(403).json({ error: 'Student nepatří do vaší třídy' });
  }
  if (!teacherOwnsTopic(req.user.id, topicId)) {
    return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
  }
  if (!studentAssignedToTopic(studentId, topicId)) {
    return res.status(403).json({ error: 'Téma není tomuto studentovi přiřazeno' });
  }
  const msgs = db.prepare('SELECT role, content, timestamp FROM messages WHERE user_id = ? AND topic_id = ? ORDER BY id').all(studentId, topicId);
  res.json(msgs);
});

app.post('/api/chat/:topicId/messages/:messageId/reactions', auth, (req, res) => {
  const userId = req.user.id;
  const { emoji } = req.body;
  const messageId = Number(req.params.messageId);
  if (!emoji) return res.status(400).json({ error: 'Chybí emoji' });
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Přístup zamítnut' });
  const topicId = Number(req.params.topicId);
  if (!studentAssignedToTopic(userId, topicId)) {
    return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
  }
  const msg = db.prepare('SELECT id, user_id, topic_id FROM messages WHERE id = ?').get(messageId);
  if (!msg || msg.user_id !== userId || msg.topic_id !== topicId) {
    return res.status(403).json({ error: 'Nemáte přístup k této zprávě' });
  }

  // Toggle reaction (add / remove)
  const existing = db.prepare('SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(messageId, userId, emoji);
  if (existing) {
    db.prepare('DELETE FROM message_reactions WHERE id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(messageId, userId, emoji);
  }

  const reactions = db.prepare(
    'SELECT emoji, COUNT(*) as count, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as me FROM message_reactions WHERE message_id = ? GROUP BY emoji'
  ).all(userId, messageId);

  res.json({ reactions: reactions.map(r => ({ emoji: r.emoji, count: r.count, me: !!r.me })) });
});

app.get('/api/chat/:topicId/messages/:messageId/reactions', auth, (req, res) => {
  const userId = req.user.id;
  const messageId = Number(req.params.messageId);
  const topicId = Number(req.params.topicId);
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Přístup zamítnut' });
  if (!studentAssignedToTopic(userId, topicId)) {
    return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
  }
  const msg = db.prepare('SELECT id, user_id, topic_id FROM messages WHERE id = ?').get(messageId);
  if (!msg || msg.user_id !== userId || msg.topic_id !== topicId) {
    return res.status(403).json({ error: 'Nemáte přístup k této zprávě' });
  }
  const reactions = db.prepare(
    'SELECT emoji, COUNT(*) as count, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as me FROM message_reactions WHERE message_id = ? GROUP BY emoji'
  ).all(userId, messageId);
  res.json({ reactions: reactions.map(r => ({ emoji: r.emoji, count: r.count, me: !!r.me })) });
});

app.post('/api/chat/:topicId', auth, async (req, res) => {
  const { message } = req.body;
  const userId = req.user.id;
  const topicId = Number(req.params.topicId);
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Přístup zamítnut' });
  }
  if (!studentAssignedToTopic(userId, topicId)) {
    return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
  }
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  if (!topic) return res.status(404).json({ error: 'Téma nenalezeno' });

  // Save user message
  const userMsgResult = db.prepare('INSERT INTO messages (user_id, topic_id, role, content) VALUES (?, ?, ?, ?)').run(userId, topicId, 'user', message);
  const userMessageId = userMsgResult.lastInsertRowid;

  // Update streak & XP
  updateStreak(userId);
  db.prepare('UPDATE users SET xp = xp + 5 WHERE id = ?').run(userId);

  // Load history
  const history = db.prepare('SELECT role, content FROM messages WHERE user_id = ? AND topic_id = ? ORDER BY id').all(userId, topicId);
  const userMsgCount = history.filter(m => m.role === 'user').length;
  const minMessages = topic.min_messages || 10;
  const remaining = Math.max(0, minMessages - userMsgCount);

  // Get AI instructions
  let aiInstructions = '';
  const student = db.prepare('SELECT class_id FROM users WHERE id = ?').get(userId);
  if (student && student.class_id) {
    const teacherClass = db.prepare('SELECT c.teacher_id FROM classes c WHERE c.id = ?').get(student.class_id);
    if (teacherClass) {
      // Get topic-specific instructions first, then global
      const topicInstruction = db.prepare(`
        SELECT instructions FROM ai_instructions 
        WHERE teacher_id = ? AND topic_id = ?
      `).get(teacherClass.teacher_id, topicId);
      
      const globalInstruction = db.prepare(`
        SELECT instructions FROM ai_instructions 
        WHERE teacher_id = ? AND is_global = TRUE
      `).get(teacherClass.teacher_id);
      
      aiInstructions = topicInstruction?.instructions || globalInstruction?.instructions || '';
    }
  }

  const levelDesc = { A1: 'úplný začátečník', A2: 'mírně pokročilý', B1: 'středně pokročilý', B2: 'pokročilý', C1: 'velmi pokročilý' };
  const levelGuidelines = {
    A1: 'Používej velmi jednoduché věty (max. 4-6 slov), základní slovní zásobu, především přítomný čas, a vysvětluj nová slova příklady.',
    A2: 'Používej jednoduché až mírně složité věty, vysvětluj novou slovní zásobu v kontextu a dej příklady.',
    B1: 'Používej přirozenou, plynulou řeč s občasnou strečovou větou; vysvětli složitější výrazy a nabídni alternativy.',
    B2: 'Používej pokročilé větné struktury, spojky, podmínkové věty a idiomy; ptej se na detaily i abstraktní témata.',
    C1: 'Používej bohatý slovník, složité větné konstrukce a idiomy; pokládej otevřené otázky a diskutuj nuance.'
  };

  const a1ExtraRules = topic.level === 'A1'
    ? '\nPravidla pro A1:\n- Ptej se vždy jen na 1 věc\n- Piš 1–2 krátké věty (max. 6 slov)\n- Nenabízej vzorové odpovědi, jen naznač téma\n- Můžeš přidat 1 emoji na konec otázky'
    : '';

  const systemPrompt = `Jsi přátelský lektor českého jazyka. Tvé jméno je Kámo. Vedeš konverzaci se studentem na téma: "${topic.title}" (${topic.description}).
Úroveň studenta: ${topic.level} (${levelDesc[topic.level] || 'mírně pokročilý'}).
Styl odpovědí: ${levelGuidelines[topic.level] || levelGuidelines.A2}
Student odeslal ${userMsgCount} z ${minMessages} zpráv. ${remaining <= 3 && remaining > 0 ? 'Konverzace se blíží ke konci!' : ''}
${aiInstructions ? `\nDodatečné instrukce od učitele:\n${aiInstructions}` : ''}
${a1ExtraRules}

Pravidla:
- Komunikuj POUZE česky, nikdy nepřepínej do jiného jazyka (ani když o to student požádá nebo je UI v jiném jazyce)
- Buď přátelský a povzbudivý
- Přizpůsob slovní zásobu úrovni studenta
- Ptej se na detaily a udržuj konverzaci
- Nepiš vzorové odpovědi, jen naznač, o čem může student mluvit
- Pokud studentovi zbývá málo zpráv do konce, upozorni ho: "Blížíme se ke konci, zkus shrnout, co ses naučil/a."`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
  ];

  try {
    const completion = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages });
    const aiMessage = completion.choices[0].message.content;

    const assistantMsgResult = db.prepare('INSERT INTO messages (user_id, topic_id, role, content) VALUES (?, ?, ?, ?)').run(userId, topicId, 'assistant', aiMessage);
    const assistantMessageId = assistantMsgResult.lastInsertRowid;

    db.prepare('UPDATE users SET xp = xp + 3 WHERE id = ?').run(userId);

    const newBadges = checkAndAwardBadges(userId);
    const user = db.prepare('SELECT xp, streak FROM users WHERE id = ?').get(userId);

    res.json({
      reply: aiMessage,
      assistantMessageId,
      userMessageId,
      xp: user.xp,
      streak: user.streak,
      newBadges: newBadges.map(k => BADGE_DEFS[k]),
      messageCount: userMsgCount,
      minMessages,
    });
  } catch (err) {
    console.error('OpenAI error:', err.message);
    res.status(500).json({ error: 'Chyba při komunikaci s AI: ' + err.message });
  }
});

app.post('/api/chat/:topicId/retry', auth, async (req, res) => {
  const userId = req.user.id;
  const topicId = Number(req.params.topicId);
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Přístup zamítnut' });
  }
  if (!studentAssignedToTopic(userId, topicId)) {
    return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
  }
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  if (!topic) return res.status(404).json({ error: 'Téma nenalezeno' });

  const lastUserMsg = db.prepare('SELECT content FROM messages WHERE user_id = ? AND topic_id = ? AND role = ? ORDER BY id DESC LIMIT 1').get(userId, topicId, 'user');
  if (!lastUserMsg) return res.status(400).json({ error: 'Žádná uživatelská zpráva k zopakování' });

  const history = db.prepare('SELECT role, content FROM messages WHERE user_id = ? AND topic_id = ? ORDER BY id').all(userId, topicId);
  const userMsgCount = history.filter(m => m.role === 'user').length;
  const minMessages = topic.min_messages || 10;
  const remaining = Math.max(0, minMessages - userMsgCount);

  // Get AI instructions
  let aiInstructions = '';
  const student = db.prepare('SELECT class_id FROM users WHERE id = ?').get(userId);
  if (student && student.class_id) {
    const teacherClass = db.prepare('SELECT c.teacher_id FROM classes c WHERE c.id = ?').get(student.class_id);
    if (teacherClass) {
      // Get topic-specific instructions first, then global
      const topicInstruction = db.prepare(`
        SELECT instructions FROM ai_instructions 
        WHERE teacher_id = ? AND topic_id = ?
      `).get(teacherClass.teacher_id, topicId);
      
      const globalInstruction = db.prepare(`
        SELECT instructions FROM ai_instructions 
        WHERE teacher_id = ? AND is_global = TRUE
      `).get(teacherClass.teacher_id);
      
      aiInstructions = topicInstruction?.instructions || globalInstruction?.instructions || '';
    }
  }

  const levelDesc = { A1: 'úplný začátečník', A2: 'mírně pokročilý', B1: 'středně pokročilý', B2: 'pokročilý', C1: 'velmi pokročilý' };
  const levelGuidelines = {
    A1: 'Používej velmi jednoduché věty (max. 4-6 slov), základní slovní zásobu, především přítomný čas, a vysvětluj nová slova příklady.',
    A2: 'Používej jednoduché až mírně složité věty, vysvětluj novou slovní zásobu v kontextu a dej příklady.',
    B1: 'Používej přirozenou, plynulou řeč s občasnou strečovou větou; vysvětli složitější výrazy a nabídni alternativy.',
    B2: 'Používej pokročilé větné struktury, spojky, podmínkové věty a idiomy; ptej se na detaily i abstraktní témata.',
    C1: 'Používej bohatý slovník, složité větné konstrukce a idiomy; pokládej otevřené otázky a diskutuj nuance.'
  };

  const a1ExtraRules = topic.level === 'A1'
    ? '\nPravidla pro A1:\n- Ptej se vždy jen na 1 věc\n- Piš 1–2 krátké věty (max. 6 slov)\n- Nenabízej vzorové odpovědi, jen naznač téma\n- Můžeš přidat 1 emoji na konec otázky'
    : '';

  const systemPrompt = `Jsi přátelský lektor českého jazyka. Tvé jméno je Kámo. Vedeš konverzaci se studentem na téma: "${topic.title}" (${topic.description}).
Úroveň studenta: ${topic.level} (${levelDesc[topic.level] || 'mírně pokročilý'}).
Styl odpovědí: ${levelGuidelines[topic.level] || levelGuidelines.A2}
Student odeslal ${userMsgCount} z ${minMessages} zpráv. ${remaining <= 3 && remaining > 0 ? 'Konverzace se blíží ke konci!' : ''}
${aiInstructions ? `\nDodatečné instrukce od učitele:\n${aiInstructions}` : ''}
${a1ExtraRules}

Pravidla:
- Komunikuj POUZE česky, nikdy nepřepínej do jiného jazyka (ani když o to student požádá nebo je UI v jiném jazyce)
- Buď přátelský a povzbudivý
- Přizpůsob slovní zásobu úrovni studenta
- Ptej se na detaily a udržuj konverzaci
- Nepiš vzorové odpovědi, jen naznač, o čem může student mluvit
- Pokud studentovi zbývá málo zpráv do konce, upozorni ho: "Blížíme se ke konci, zkus shrnout, co ses naučil/a."`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
  ];

  try {
    const completion = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages });
    const aiMessage = completion.choices[0].message.content;

    const assistantMsgResult = db.prepare('INSERT INTO messages (user_id, topic_id, role, content) VALUES (?, ?, ?, ?)').run(userId, topicId, 'assistant', aiMessage);
    const assistantMessageId = assistantMsgResult.lastInsertRowid;

    res.json({ reply: aiMessage, assistantMessageId });
  } catch (err) {
    console.error('OpenAI retry error:', err.message);
    res.status(500).json({ error: 'Chyba při opakování: ' + err.message });
  }
});

// --- CONVERSATION EVALUATION ---
app.post('/api/chat/:topicId/evaluate', auth, async (req, res) => {
  const topicId = Number(req.params.topicId);
  let userId = req.user.id;
  if (req.user.role === 'teacher') {
    if (!req.body.studentId) {
      return res.status(400).json({ error: 'Chybí studentId' });
    }
    const studentId = Number(req.body.studentId);
    if (!teacherOwnsStudent(req.user.id, studentId)) {
      return res.status(403).json({ error: 'Student nepatří do vaší třídy' });
    }
    if (!teacherOwnsTopic(req.user.id, topicId)) {
      return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
    }
    if (!studentAssignedToTopic(studentId, topicId)) {
      return res.status(403).json({ error: 'Téma není tomuto studentovi přiřazeno' });
    }
    userId = studentId;
  } else {
    if (!studentAssignedToTopic(userId, topicId)) {
      return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
    }
  }
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  const history = db.prepare('SELECT role, content FROM messages WHERE user_id = ? AND topic_id = ? ORDER BY id').all(userId, topicId);

  if (history.length < 2) return res.status(400).json({ error: 'Příliš málo zpráv pro hodnocení' });

  const evalPrompt = `Jsi laskavý a povzbudivý hodnotitel českého jazyka. Hodnocení bude především o tom, aby se žák cítil motivovaný (ne odraděný). Zhodnoť následující konverzaci studenta (úroveň ${topic.level}) na téma "${topic.title}".

Konverzace:
${history.map(m => `${m.role === 'user' ? 'Student' : 'Lektor'}: ${m.content}`).join('\n')}

Udělej hodnocení v tomto formátu (česky):
- score: číslo 1-10 (1=potřebuje více tréninku, 10=skvělé)
- grade: školní známka 1-5 (1=skvělé, 5=potřebuje zlepšení)
- evaluation: přátelské shrnutí, co bylo nejlepší a co je dobré trénovat dál (1-2 odstavce)
- strengths: silné stránky
- improvements: oblasti ke zlepšení (doporučení)
- vocabulary: seznam max 5 nejdůležitějších slovíček z lekce
  - každé slovíčko má: word (česky), translation (volitelný překlad), context_sentence (volitelná krátká věta)

Buď co nejkonkrétnější a laskavý. Odpověď ulož jako čistý JSON (žádný jiný text).`;

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
      const match = raw.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
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
    const vocabItems = Array.isArray(parsed?.vocabulary) ? parsed.vocabulary : [];

    // Store evaluation record
    db.prepare(
      'INSERT INTO evaluations (topic_id, student_id, score, grade, evaluation) VALUES (?, ?, ?, ?, ?)'
    ).run(topicId, userId, score, grade, evaluationText);

    // Award bonus XP for completing evaluation
    db.prepare('UPDATE users SET xp = xp + 20 WHERE id = ?').run(userId);

    // Save vocabulary (max 5, skip duplicates)
    const savedVocabulary = [];
    for (const item of vocabItems.slice(0, 5)) {
      const word = String(item?.word || '').trim();
      if (!word) continue;
      const exists = db.prepare('SELECT 1 FROM vocabulary WHERE user_id = ? AND lower(word) = lower(?)').get(userId, word);
      if (exists) continue;
      const translation = item?.translation ? String(item.translation).trim() : '';
      const context = item?.context_sentence ? String(item.context_sentence).trim() : '';
      const result = db.prepare(
        'INSERT INTO vocabulary (user_id, word, translation, context_sentence) VALUES (?, ?, ?, ?)'
      ).run(userId, word, translation, context);
      savedVocabulary.push({ id: result.lastInsertRowid, word, translation, context_sentence: context });
    }

    logAudit(req.user.id, 'chat_evaluate', 'topic', topicId, { studentId: userId });
    res.json({ evaluation: evaluationText, score, grade, vocabularyAdded: savedVocabulary });
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
  if (!user) return res.status(404).json({ error: 'Uživatel nenalezen' });

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

  const students = db.prepare(
    `SELECT u.id, u.name, u.username, u.xp, u.streak
     FROM users u
     JOIN classes c ON c.id = u.class_id
     WHERE u.role = 'student' AND c.teacher_id = ?`
  ).all(req.user.id);
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
  let studentId = req.query.studentId ? Number(req.query.studentId) : req.user.id;
  if (req.user.role === 'teacher') {
    if (!teacherOwnsStudent(req.user.id, studentId)) {
      return res.status(403).json({ error: 'Student nepatří do vaší třídy' });
    }
    if (!teacherOwnsTopic(req.user.id, topicId)) {
      return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
    }
  } else {
    if (studentId !== req.user.id) {
      return res.status(403).json({ error: 'Přístup zamítnut' });
    }
    if (!studentAssignedToTopic(studentId, topicId)) {
      return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
    }
  }
  const evaluation = db
    .prepare('SELECT * FROM evaluations WHERE topic_id = ? AND student_id = ? ORDER BY id DESC LIMIT 1')
    .get(topicId, studentId);
  if (!evaluation) return res.json({ evaluation: null });
  res.json({
    evaluation: evaluation.evaluation,
    score: evaluation.score,
    grade: evaluation.grade,
    quiz_score: evaluation.quiz_score,
    quiz_total: evaluation.quiz_total,
    created_at: evaluation.created_at,
  });
});

app.post('/api/chat/:topicId/quiz-score', auth, (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Přístup zamítnut' });
  const topicId = Number(req.params.topicId);
  const score = Number(req.body?.score);
  const total = Number(req.body?.total);

  if (!topicId || Number.isNaN(topicId)) {
    return res.status(400).json({ error: 'Neplatné ID tématu' });
  }
  if (Number.isNaN(score) || Number.isNaN(total) || total <= 0 || score < 0 || score > total) {
    return res.status(400).json({ error: 'Neplatné skóre' });
  }
  if (!studentAssignedToTopic(req.user.id, topicId)) {
    return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
  }

  const evaluation = db
    .prepare('SELECT id FROM evaluations WHERE topic_id = ? AND student_id = ? ORDER BY id DESC LIMIT 1')
    .get(topicId, req.user.id);
  if (!evaluation) return res.status(404).json({ error: 'Hodnocení nenalezeno' });

  db.prepare('UPDATE evaluations SET quiz_score = ?, quiz_total = ? WHERE id = ?')
    .run(score, total, evaluation.id);

  res.json({ ok: true });
});

// --- FEEDBACK ---
app.post('/api/feedback', auth, (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Přístup zamítnut' });
  const { topicId, rating, text } = req.body;
  const parsedTopicId = Number(topicId);
  const parsedRating = Number(rating);

  if (!parsedTopicId || Number.isNaN(parsedTopicId)) {
    return res.status(400).json({ error: 'Neplatné ID tématu' });
  }
  if (Number.isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
    return res.status(400).json({ error: 'Hodnocení musí být 1–5' });
  }
  if (!studentAssignedToTopic(req.user.id, parsedTopicId)) {
    return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
  }

  db.prepare(
    'INSERT INTO feedback (topic_id, student_id, rating, text) VALUES (?, ?, ?, ?)'
  ).run(parsedTopicId, req.user.id, parsedRating, (text || '').toString().trim());

  res.status(201).json({ ok: true });
});

app.get('/api/feedback', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });
  const rows = db.prepare(`
    SELECT f.id, f.topic_id, f.rating, f.text, f.created_at,
           t.title AS topic_title,
           u.id AS student_id, u.name AS student_name
    FROM feedback f
    JOIN users u ON u.id = f.student_id
    JOIN classes c ON c.id = u.class_id
    LEFT JOIN topics t ON t.id = f.topic_id
    WHERE c.teacher_id = ?
    ORDER BY f.created_at DESC
  `).all(req.user.id);

  const avgRow = db.prepare(`
    SELECT AVG(f.rating) as avg_rating, COUNT(*) as total
    FROM feedback f
    JOIN users u ON u.id = f.student_id
    JOIN classes c ON c.id = u.class_id
    WHERE c.teacher_id = ?
  `).get(req.user.id);

  res.json({
    average: avgRow?.avg_rating ? Number(avgRow.avg_rating.toFixed(2)) : null,
    total: avgRow?.total || 0,
    items: rows,
  });
});

// --- LECTURES CRUD ---
app.get('/api/lectures', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });

  const lectures = db.prepare(`
    SELECT l.*, t.title as topic_title 
    FROM lectures l
    LEFT JOIN topics t ON t.id = l.topic_id
    WHERE l.teacher_id = ?
    ORDER BY l.created_at DESC
  `).all(req.user.id);
  
  res.json(lectures);
});

app.post('/api/lectures', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });

  const { title, content, topicId } = req.body;
  
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Název přednášky je povinný' });
  }
  
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Obsah přednášky je povinný' });
  }

  try {
    const result = db.prepare(`
      INSERT INTO lectures (teacher_id, topic_id, title, content, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(
      req.user.id,
      topicId || null,
      title.trim(),
      content.trim()
    );

    logAudit(req.user.id, 'lecture_create', 'lecture', result.lastInsertRowid, { title: title.trim() });
    res.json({ 
      id: result.lastInsertRowid,
      message: 'Přednáška vytvořena' 
    });
  } catch (err) {
    console.error('Lecture creation error:', err);
    res.status(500).json({ error: 'Chyba při vytváření přednášky' });
  }
});

app.delete('/api/lectures/:id', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });

  try {
    const result = db.prepare(`
      DELETE FROM lectures 
      WHERE id = ? AND teacher_id = ?
    `).run(req.params.id, req.user.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Přednáška nenalezena' });
    }

    logAudit(req.user.id, 'lecture_delete', 'lecture', Number(req.params.id));
    res.json({ message: 'Přednáška smazána' });
  } catch (err) {
    console.error('Lecture deletion error:', err);
    res.status(500).json({ error: 'Chyba při mazání přednášky' });
  }
});

// --- LECTURE ASSIGNMENTS CRUD ---
app.get('/api/lecture-assignments', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });

  const assignments = db.prepare(`
    SELECT la.*, l.title as lecture_title, 
           GROUP_CONCAT(u.name, ' (', u.username, ')') as students
    FROM lecture_assignments la
    JOIN lectures l ON l.id = la.lecture_id
    JOIN users u ON u.id = la.student_id
    WHERE la.teacher_id = ?
    ORDER BY la.created_at DESC
  `).all(req.user.id);
  
  res.json(assignments);
});

app.post('/api/lecture-assignments', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });

  const { lectureId, studentIds } = req.body;
  
  if (!lectureId || !studentIds || studentIds.length === 0) {
    return res.status(400).json({ error: 'Přednáška a studenti jsou povinné' });
  }

  try {
    const lecture = db.prepare('SELECT id FROM lectures WHERE id = ? AND teacher_id = ?').get(lectureId, req.user.id);
    if (!lecture) {
      return res.status(404).json({ error: 'Přednáška nenalezena' });
    }
    for (const studentId of studentIds) {
      if (!teacherOwnsStudent(req.user.id, studentId)) {
        return res.status(403).json({ error: 'Student nepatří do vaší třídy' });
      }
    }
    // Delete existing assignments for this lecture
    db.prepare('DELETE FROM lecture_assignments WHERE lecture_id = ?').run(lectureId);
    
    // Create new assignments
    const stmt = db.prepare(`
      INSERT INTO lecture_assignments (teacher_id, lecture_id, student_id, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `);
    
    studentIds.forEach(studentId => {
      stmt.run(req.user.id, lectureId, studentId);
    });

    logAudit(req.user.id, 'lecture_assign', 'lecture', lectureId, { studentIds });
    res.json({ 
      message: 'Studenti přiřazeni k přednášce',
      assigned: studentIds.length
    });
  } catch (err) {
    console.error('Assignment creation error:', err);
    res.status(500).json({ error: 'Chyba při přiřazování studentů' });
  }
});

app.delete('/api/lecture-assignments/:id', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Přístup zamítnut' });

  try {
    const result = db.prepare(`
      DELETE FROM lecture_assignments 
      WHERE id = ? AND teacher_id = ?
    `).run(req.params.id, req.user.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Přiřazení nenalezeno' });
    }

    res.json({ message: 'Přiřazení smazáno' });
  } catch (err) {
    console.error('Assignment deletion error:', err);
    res.status(500).json({ error: 'Chyba při mazání přiřazení' });
  }
});

// --- STUDENT LECTURES ---
app.get('/api/my-lectures', auth, (req, res) => {
  console.log('Student lectures API called by:', req.user.username, 'role:', req.user.role);
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Přístup zamítnut' });

  try {
    const lectures = db.prepare(`
      SELECT l.*, la.created_at as assigned_at, t.title as topic_title
      FROM lecture_assignments la
      JOIN lectures l ON l.id = la.lecture_id
      LEFT JOIN topics t ON t.id = l.topic_id
      WHERE la.student_id = ?
      ORDER BY la.created_at DESC
    `).all(req.user.id);
    
    console.log('Found lectures for student:', lectures.length);
    res.json(lectures);
  } catch (err) {
    console.error('Error fetching student lectures:', err);
    res.status(500).json({ error: 'Chyba při načítání přednášek' });
  }
});

// --- LECTURE CHAT ---
app.post('/api/chat/lecture/:lectureId', auth, async (req, res) => {
  console.log('Lecture chat API called by:', req.user.username, 'role:', req.user.role);
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Přístup zamítnut' });

  const { message, lectureContent } = req.body;
  const { lectureId } = req.params;
  
  console.log('Lecture chat request:', { lectureId, messageLength: message?.length, hasLectureContent: !!lectureContent });

  try {
    // Verify student has access to this lecture
    const assignment = db.prepare(`
      SELECT la.*, l.title, l.content
      FROM lecture_assignments la
      JOIN lectures l ON l.id = la.lecture_id
      WHERE la.student_id = ? AND la.lecture_id = ?
    `).get(req.user.id, lectureId);

    if (!assignment) {
      console.log('Student does not have access to lecture:', lectureId);
      return res.status(403).json({ error: 'Nemáte přístup k této přednášce' });
    }

    console.log('Student has access to lecture:', assignment.title);

    // Create system prompt with lecture content
    const systemPrompt = `Jsi AI učitel češtiny. Student právě studuje následující přednášku:

${lectureContent}

Odpovídej na otázky studenta týkající se této přednášky. Pomáháj mu s porozuměním, vysvětluj nejasnosti a poskytuj doplňující informace. Mluv česky a přátelsky. Nikdy nepřepínej do jiného jazyka.`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ];

    console.log('Sending to OpenAI...');

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages,
      max_tokens: 500,
      temperature: 0.7,
    });

    const reply = completion.choices[0].message.content;
    console.log('OpenAI response received, length:', reply?.length);

    // Save message (optional - for lecture tracking)
    const userMsgId = db.prepare(`
      INSERT INTO messages (user_id, topic_id, role, content, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(req.user.id, lectureId, 'user', message).lastInsertRowid;

    const assistantMsgId = db.prepare(`
      INSERT INTO messages (user_id, topic_id, role, content, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(req.user.id, lectureId, 'assistant', reply).lastInsertRowid;

    res.json({ 
      reply,
      userMessageId: userMsgId,
      assistantMessageId: assistantMsgId
    });

  } catch (error) {
    console.error('Lecture chat error:', error);
    res.status(500).json({ error: 'Chyba při zpracování chatu' });
  }
});

app.get('/api/me/evaluations', auth, (req, res) => {
  let rows;
  if (req.user.role === 'teacher') {
    // Teachers see all evaluations for their students
    rows = db.prepare(`
      SELECT e.id, e.topic_id, t.title as topic, e.score, e.grade, e.quiz_score, e.quiz_total, e.created_at, u.name as student_name, u.username as student_username
      FROM evaluations e
      JOIN topics t ON t.id = e.topic_id
      JOIN users u ON u.id = e.student_id
      JOIN classes c ON c.id = u.class_id
      WHERE c.teacher_id = ?
      ORDER BY e.created_at DESC
    `).all(req.user.id);
  } else {
    // Students see only their own evaluations
    rows = db.prepare(`
      SELECT e.id, e.topic_id, t.title as topic, e.score, e.grade, e.quiz_score, e.quiz_total, e.created_at
      FROM evaluations e
      JOIN topics t ON t.id = e.topic_id
      WHERE e.student_id = ?
      ORDER BY e.created_at DESC
    `).all(req.user.id);
  }
  res.json(rows);
});

// --- CHAT EXPORT ---
app.get('/api/chat/:topicId/export', auth, (req, res) => {
  const topicId = Number(req.params.topicId);
  const studentId = req.query.studentId ? Number(req.query.studentId) : req.user.id;
  if (req.user.role === 'teacher') {
    if (!teacherOwnsStudent(req.user.id, studentId)) {
      return res.status(403).json({ error: 'Student nepatří do vaší třídy' });
    }
    if (!teacherOwnsTopic(req.user.id, topicId)) {
      return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
    }
  } else {
    if (studentId !== req.user.id) {
      return res.status(403).json({ error: 'Přístup zamítnut' });
    }
    if (!studentAssignedToTopic(studentId, topicId)) {
      return res.status(403).json({ error: 'Nemáte přístup k tomuto tématu' });
    }
  }
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);
  if (!topic) return res.status(404).json({ error: 'Téma nenalezeno' });
  const msgs = db.prepare('SELECT role, content, timestamp FROM messages WHERE user_id = ? AND topic_id = ? ORDER BY id').all(studentId, topicId);
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
  logAudit(req.user.id, 'chat_export', 'topic', topicId, { studentId });
  res.send(text);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Czech Tutor API běží na portu ${PORT}`));
