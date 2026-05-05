import { runBackup } from '@/workers/backup.js';

runBackup()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('backup failed:', err);
    process.exit(1);
  });
