import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BusinessService } from '../../core/business.service';

/**
 * CCTV is recorded and streamed by the camera system (NVR/DVR or cloud
 * camera), never by this app. This page links to the system's own secure
 * remote-viewing app, which handles video, encryption and login.
 */
@Component({
  selector: 'app-cctv',
  imports: [RouterLink],
  template: `
    <div class="page-head"><h1>CCTV</h1></div>

    @if (configured()) {
      <div class="card">
        <h2>{{ cctv().provider || 'Camera system' }}</h2>
        <p class="muted small">Opens your camera system's own secure viewer. You will sign in with the camera app's account, not your Kota House login.</p>
        <div class="stack">
          @if (cctv().viewerUrl) {
            <a class="btn primary xl block" [href]="cctv().viewerUrl" target="_blank" rel="noopener noreferrer">📹 Open live view</a>
          }
          <div class="row">
            @if (cctv().androidAppUrl) {
              <a class="btn" [href]="cctv().androidAppUrl" target="_blank" rel="noopener noreferrer">Android app</a>
            }
            @if (cctv().iosAppUrl) {
              <a class="btn" [href]="cctv().iosAppUrl" target="_blank" rel="noopener noreferrer">iPhone app</a>
            }
          </div>
        </div>
        @if (cctv().notes) {
          <div class="divider"></div>
          <p class="small" style="white-space: pre-line">{{ cctv().notes }}</p>
        }
      </div>
    } @else {
      <div class="card">
        <h2>Connect your cameras</h2>
        <p>No camera system is set up yet. Add your camera app's links in <a routerLink="/settings">Settings › CCTV</a>.</p>
      </div>
    }

    <div class="card">
      <h2>Good practice</h2>
      <ul class="small">
        <li>Point one camera at the till and counter, and one at the stock and fridge area.</li>
        <li>Recording stays on the recorder (NVR/DVR) or the camera brand's cloud. This app never stores video.</li>
        <li>Use the brand's official app with a strong, unique password and two-step login if offered. Change the recorder's default admin password.</li>
        <li>Prefer the brand's cloud/P2P remote view over opening router ports. Never port-forward the recorder without a VPN.</li>
        <li>Put up a notice that CCTV is in operation. Under POPIA, staff and customers must be told about camera recording.</li>
        <li>Compare a cash difference on the Cash-ups page with the till camera footage at the same time.</li>
      </ul>
      <p class="tiny">See docs/CCTV.md for setup and network requirements.</p>
    </div>
  `,
})
export class CctvPage {
  private readonly biz = inject(BusinessService);
  protected readonly cctv = computed(() => this.biz.settings().cctv);
  protected readonly configured = computed(() => !!(this.cctv().viewerUrl || this.cctv().androidAppUrl || this.cctv().iosAppUrl));
}
