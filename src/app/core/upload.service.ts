import { Injectable, inject } from '@angular/core';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { AuthService } from './auth.service';
import { FirebaseService } from './firebase.service';

const MAX_BYTES = 5 * 1024 * 1024;

/** Receipt uploads go to businesses/{b}/receipts/{uid}/… (see storage.rules). */
@Injectable({ providedIn: 'root' })
export class UploadService {
  private readonly fb = inject(FirebaseService);
  private readonly auth = inject(AuthService);

  async uploadReceipt(file: File): Promise<string> {
    if (!file.type.startsWith('image/') && file.type !== 'application/pdf') throw new Error('Receipt must be a photo or PDF');
    const blob = file.type.startsWith('image/') ? await shrinkImage(file) : file;
    if (blob.size > MAX_BYTES) throw new Error('Receipt file is too large (max 5 MB)');
    const ext = blob.type === 'application/pdf' ? 'pdf' : 'jpg';
    const path = `businesses/${this.auth.businessId()}/receipts/${this.auth.uid()}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    await uploadBytes(ref(this.fb.storage, path), blob, { contentType: blob.type });
    return path;
  }

  url(path: string): Promise<string> {
    return getDownloadURL(ref(this.fb.storage, path));
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
