import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import { ShellComponent } from './shell.component';
import { AuthService } from '../core/auth.service';
import { BusinessService } from '../core/business.service';
import { ToastService } from '../core/toast.service';
import { OutboxService } from '../core/outbox.service';
import { DEFAULT_SETTINGS, Shift } from '@shared/models';

function setup(role: 'owner' | 'employee', shift: Partial<Shift> | null, queued = 0) {
  const signOut = vi.fn().mockResolvedValue(undefined);
  const auth = {
    uid: signal('emp1'),
    isOwner: signal(role === 'owner'),
    businessId: signal(null),
    memberships: signal({}),
    displayName: signal('Sipho'),
    signOut,
  };
  const biz = {
    settings: signal(DEFAULT_SETTINGS),
    openShift: signal(shift),
    // the shell's alert badges query Firestore only for owners; give them nothing to query
    col: () => null,
  };
  TestBed.configureTestingModule({
    imports: [ShellComponent],
    providers: [provideRouter([]), { provide: AuthService, useValue: auth }, { provide: BusinessService, useValue: biz },
      { provide: OutboxService, useValue: { count: signal(queued), online: signal(true) } },
    ],
  });
  // owners would open live Firestore queries; the test only exercises sign-out
  TestBed.overrideComponent(ShellComponent, { set: { template: '' } });
  const fixture = TestBed.createComponent(ShellComponent);
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  const toast = TestBed.inject(ToastService);
  return { shell: fixture.componentInstance, signOut, navigate, toast };
}

describe('ShellComponent sign-out', () => {
  it('blocks a cashier with an open shift and sends them to cash up', async () => {
    const { shell, signOut, navigate, toast } = setup('employee', { id: 's1', employeeId: 'emp1', status: 'open' });
    await shell.signOut();
    expect(signOut).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/shift');
    expect(toast.toasts()[0].text).toContain('Close your shift');
  });

  it('lets a cashier sign out once the shift is closed', async () => {
    const { shell, signOut, navigate } = setup('employee', null);
    await shell.signOut();
    expect(signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('does not block a cashier when someone else has the open shift', async () => {
    const { shell, signOut } = setup('employee', { id: 's1', employeeId: 'other', status: 'open' });
    await shell.signOut();
    expect(signOut).toHaveBeenCalled();
  });

  it('blocks sign-out while offline sales are still on the phone', async () => {
    const { shell, signOut, toast } = setup('owner', null, 2);
    await shell.signOut();
    expect(signOut).not.toHaveBeenCalled();
    expect(toast.toasts()[0].text).toContain('saved offline');
  });

  it('never blocks the owner', async () => {
    const { shell, signOut } = setup('owner', { id: 's1', employeeId: 'emp1', status: 'open' });
    await shell.signOut();
    expect(signOut).toHaveBeenCalled();
  });
});

