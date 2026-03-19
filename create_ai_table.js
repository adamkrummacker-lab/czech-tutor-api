const db = require('better-sqlite3')('./czech-tutor.db');

console.log('Checking if ai_instructions table exists...');

try {
  // Check if table exists
  const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_instructions'").get();
  
  if (!result) {
    console.log('Creating ai_instructions table...');
    db.exec(`
      CREATE TABLE ai_instructions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
        instructions TEXT NOT NULL,
        is_global BOOLEAN DEFAULT FALSE,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(teacher_id, topic_id)
      )
    `);
    console.log('Table created successfully!');
  } else {
    console.log('ai_instructions table already exists');
  }
  
  // List all tables
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('All tables:', tables.map(t => t.name));
  
} catch (error) {
  console.error('Error:', error.message);
} finally {
  db.close();
}
