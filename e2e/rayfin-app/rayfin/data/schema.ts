// Rayfin data model registration. Each @entity lives in its own data/<Entity>.ts
// file; schema.ts imports them and registers the app schema. Rayfin provisions the
// database, data APIs (Data API Builder) and auth from these decorated classes.
import { User } from './User.js';
import { Category } from './Category.js';
import { Project } from './Project.js';
import { Todo } from './Todo.js';
import { Tag } from './Tag.js';
import { Comment } from './Comment.js';

export type AppSchema = {
  User: User;
  Category: Category;
  Project: Project;
  Todo: Todo;
  Tag: Tag;
  Comment: Comment;
};

export const schema = [User, Category, Project, Todo, Tag, Comment];
