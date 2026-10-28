import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { ToastService } from './core/toast.service';
import { provideRouter } from '@angular/router';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [App], providers: [provideRouter([])] }).compileComponents();
  });

  it('renders toasts from the toast service', async () => {
    const fixture = TestBed.createComponent(App);
    TestBed.inject(ToastService).ok('Sale saved');
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.toast')?.textContent).toContain('Sale saved');
  });
});
