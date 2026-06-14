import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../conversions.db');

// 初始化数据库连接
const db = new DatabaseSync(dbPath);

// 建表
db.exec(`
  CREATE TABLE IF NOT EXISTS conversions (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    output_dir TEXT NOT NULL,
    converted INTEGER DEFAULT 0,
    images_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

export function saveConversion({ id, filename, filePath, outputDir, converted = 1, imagesCount = 0 }) {
  const stmt = db.prepare(`
    INSERT INTO conversions (id, filename, file_path, output_dir, converted, images_count)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      filename = excluded.filename,
      file_path = excluded.file_path,
      output_dir = excluded.output_dir,
      converted = excluded.converted,
      images_count = excluded.images_count,
      created_at = CURRENT_TIMESTAMP
  `);
  stmt.run(id, filename, filePath, outputDir, converted, imagesCount);
}

export function getConversion(id) {
  const stmt = db.prepare('SELECT * FROM conversions WHERE id = ?');
  return stmt.get(id);
}

export function getAllConversions() {
  const stmt = db.prepare('SELECT * FROM conversions ORDER BY created_at DESC');
  return stmt.all();
}

export function deleteConversion(id) {
  const stmt = db.prepare('DELETE FROM conversions WHERE id = ?');
  stmt.run(id);
}
