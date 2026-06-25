// Rayfin data model. Decorators describe entities, fields, relationships and the
// roles allowed to read/write them; Rayfin provisions the database, data APIs
// (Data API Builder) and auth from this file.
import { entity, role, text, uuid, boolean, date, email, one, many } from "@microsoft/rayfin";

@role("admin")
@role("member")
export class User {
  @uuid()
  id!: string;

  @email()
  email!: string;

  @text()
  displayName!: string;

  @many(() => Todo, "owner")
  todos!: Todo[];
}

@entity()
export class Todo {
  @uuid()
  id!: string;

  @text({ maxLength: 200 })
  title!: string;

  @text({ nullable: true })
  notes?: string;

  @boolean({ default: false })
  done!: boolean;

  @date()
  createdAt!: Date;

  @one(() => User, "todos")
  owner!: User;
}
