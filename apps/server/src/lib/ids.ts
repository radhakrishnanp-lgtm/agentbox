import { v7 as uuidv7 } from 'uuid';

/** Time-ordered UUIDs keep inserts index-friendly and sort by creation time. */
export function newId(): string {
  return uuidv7();
}
