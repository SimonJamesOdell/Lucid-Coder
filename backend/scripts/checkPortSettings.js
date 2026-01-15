import sqlite3 from 'sqlite3';

const targetDb = process.argv[2] || 'lucidcoder.db';
console.log('Inspecting DB:', targetDb);
const db = new sqlite3.Database(targetDb);

db.all('SELECT frontend_port_base, backend_port_base FROM port_settings', (err, rows) => {
  if (err) {
    console.error('DB error:', err);
    process.exit(1);
  }
  console.log('port_settings rows:', rows);
  db.close();
});
