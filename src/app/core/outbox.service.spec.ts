import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ApiError, ApiService } from './api.service';
import { AuthService } from './auth.service';
import { OutboxService } from './outbox.service';
import { OrdersService } from './orders.service';

const sale = (id: string) => ({
  saleId: id,
  items: [{ productId: 'basic', quantity: 1 }],
  payment: { method: 'cash' as const, amountReceivedCents: 5000 },
  soldAtMillis: Date.now(),
  expectedTotalCents: 3500,
});

function setup(call: ReturnType<typeof vi.fn>) {
  TestBed.configureTestingModule({
    providers: [
      { provide: ApiService, useValue: { call } },
      { provide: AuthService, useValue: { uid: signal('emp1'), businessId: signal('biz1') } },
      { provide: OrdersService, useValue: { setReceiptNo: vi.fn() } },
    ],
  });
  const outbox = TestBed.inject(OutboxService);
  TestBed.tick(); // run the effect that loads the queue for this user
  return outbox;
}

const offline = () => new ApiError('offline', 'functions/internal', true);

describe('OutboxService', () => {
  beforeEach(() => localStorage.clear());

  it('keeps sales while offline and sends them once the network is back', async () => {
    const call = vi.fn().mockRejectedValue(offline());
    const outbox = setup(call);
    outbox.enqueue(sale('aaaaaaaaaaaaaaaa1'));
    outbox.enqueue(sale('aaaaaaaaaaaaaaaa2'));
    await outbox.flush();
    expect(outbox.pending().length).toBe(2);
    expect(call).toHaveBeenCalledTimes(1); // stops at the first network failure

    call.mockResolvedValue({ duplicate: false, receiptNo: 7 });
    await outbox.flush();
    expect(outbox.count()).toBe(0);
    expect(call.mock.calls.map((c) => c[1].saleId)).toEqual(['aaaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaaa2']);
  });

  it('re-sends with the same sale id, so the server can de-duplicate', async () => {
    const call = vi.fn().mockRejectedValueOnce(offline()).mockResolvedValue({ duplicate: true });
    const outbox = setup(call);
    outbox.enqueue(sale('bbbbbbbbbbbbbbbb1'));
    await outbox.flush();
    await outbox.flush();
    expect(call.mock.calls.every((c) => c[1].saleId === 'bbbbbbbbbbbbbbbb1')).toBe(true);
    expect(outbox.count()).toBe(0);
  });

  it('holds sales the server refused for a person to review, without blocking the rest', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Product is not available', 'functions/invalid-argument', false))
      .mockResolvedValue({ duplicate: false });
    const outbox = setup(call);
    outbox.enqueue(sale('cccccccccccccccc1'));
    outbox.enqueue(sale('cccccccccccccccc2'));
    await outbox.flush();
    expect(outbox.failed().map((f) => f.error)).toEqual(['Product is not available']);
    expect(outbox.pending().length).toBe(0);
    outbox.discard('cccccccccccccccc1');
    expect(outbox.count()).toBe(0);
  });

  it('survives a page reload', () => {
    const outbox = setup(vi.fn().mockRejectedValue(offline()));
    outbox.enqueue(sale('dddddddddddddddd1'));
    expect(JSON.parse(localStorage.getItem('kotahouse.outbox.emp1')!)).toHaveLength(1);
  });
});
