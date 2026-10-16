import { ensureTemplateDatabase } from './template-database.js';

export default async function setup(): Promise<void> {
  await ensureTemplateDatabase();
}
