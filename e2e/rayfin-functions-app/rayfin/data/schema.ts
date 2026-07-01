// Rayfin data model registration. Each @entity lives in its own data/<Entity>.ts
// file; schema.ts imports them and registers the app schema. Rayfin provisions the
// database, data APIs (Data API Builder) and auth from these decorated classes.
import { Note } from './Note.js';
import { Tag } from './Tag.js';

export type AppSchema = {
  Note: Note;
  Tag: Tag;
};

export const schema = [Note, Tag];
