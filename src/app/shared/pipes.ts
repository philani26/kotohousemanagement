import { Pipe, PipeTransform } from '@angular/core';
import { formatZar } from '@shared/money';
import { TimestampLike } from '@shared/models';

/** Formats integer cents as rand: 4550 → "R 45,50". */
@Pipe({ name: 'zar' })
export class ZarPipe implements PipeTransform {
  transform(cents: number | null | undefined): string {
    return cents === null || cents === undefined ? '–' : formatZar(cents);
  }
}

/** Firestore Timestamp (or millis) → Date, for use with the date pipe. */
@Pipe({ name: 'ts' })
export class TsPipe implements PipeTransform {
  transform(value: TimestampLike | number | null | undefined): Date | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return new Date(value);
    return typeof value.toDate === 'function' ? value.toDate() : null;
  }
}
