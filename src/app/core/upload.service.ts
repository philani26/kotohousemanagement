import { Injectable, inject } from '@angular/core';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { problem } from './live.service';

const MAX_BYTES = 5 * 1024 * 1024;

/** Receipt photos and slips: uploaded to the backend into the person's own folder (businesses/{b}/receipts/{uid}/…). */
@Injectable({ providedIn: 'root' })
export class UploadService {
  private readonly auth = inject(AuthService);

  async uploadReceipt(file: File): Promise<string> {
    if (!file.type.startsWith('image/') && file.type !== 'application/pdf') throw new Error('Receipt must be a photo or PDF');
    const blob = file.type.startsWith('image/') ? await shrinkImage(file) : file;
    if (blob.size > MAX_BYTES) throw new Error('Receipt file is too large (max 5 MB)');
    const form = new FormData();
    form.append('file', blob, blob.type === 'application/pdf' ? 'receipt.pdf' : 'receipt.jpg');
    // no Content-Type header: the browser sets the multipart boundary itself
    const res = await fetch(`${environment.apiUrl}/api/shops/${encodeURIComponent(this.auth.businessId() ?? '')}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.auth.token()}` },
      body: form,
    });
    if (!res.ok) throw await problem(res);
    return ((await res.json()) as { path: string }).path;
  }

  /** A link that opens the receipt for five minutes (only for the owner or the uploader). */
  async url(path: string): Promise<string> {
    const res = await this.auth.fetch(`/api/shops/${encodeURIComponent(this.auth.businessId() ?? '')}/files/link?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw await problem(res);
    return environment.apiUrl + ((await res.json()) as { url: string }).url;
  }
}

/** Phone photos are large; scale to ~1600px JPEG to save data and storage. */
async function shrinkImage(file: File, maxSide = 1600): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/jpeg', 0.8));
  } catch {
    return file;
  }
}
