import { publish, withLock } from '../dist/storage/files.js';
const [directory, file, stage, content] = process.argv.slice(2);
await withLock(directory, async () => {
  await publish(file, content, async (checkpoint) => {
    if (checkpoint === stage) {
      process.send({ stage: checkpoint });
      await new Promise(() => {});
    }
  });
});
