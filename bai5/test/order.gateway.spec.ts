// Kiem thu end-to-end: dung server NestJS that + client socket.io that (moi client = 1 "tab").
// Cung 1 kich ban chay tren 2 ban gateway:
//   - BUGGY : khang dinh hanh vi SAI dang xay ra (tai hien loi bang du lieu)
//   - FIXED : khang dinh hanh vi DUNG sau khi va
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'net';
import { io as connectIo, Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { DebugState, GatewayVariant } from '../src/order/order-notifier';

type OrderUpdated = { orderId: string; status: string };
type Tab = { socket: ClientSocket; received: OrderUpdated[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(variant: GatewayVariant) {
  let app: INestApplication;
  let baseUrl: string;
  const openTabs: Tab[] = [];

  beforeAll(async () => {
    app = await NestFactory.create(AppModule.forRoot(variant), { logger: false });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    openTabs.splice(0).forEach((t) => t.socket.disconnect());
    await waitFor(async () => (await state()).connectedSockets === 0);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Mo 1 "tab": ket noi socket va ghi lai moi su kien order:updated nhan duoc. */
  async function openTab(): Promise<Tab> {
    const socket = connectIo(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
    const tab: Tab = { socket, received: [] };
    socket.on('order:updated', (p: OrderUpdated) => tab.received.push(p));
    await new Promise<void>((ok, fail) => {
      socket.once('connect', ok);
      socket.once('connect_error', fail);
    });
    openTabs.push(tab);
    return tab;
  }

  const track = (tab: Tab, orderId: unknown) => tab.socket.emitWithAck('order:track', orderId);

  /** Gia lap admin cap nhat don qua HTTP -> gateway.notifyStatusChanged */
  async function updateStatus(orderId: string, status: string) {
    await fetch(`${baseUrl}/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    await sleep(150); // cho su kien kip toi client
  }

  async function state(): Promise<DebugState> {
    return (await fetch(`${baseUrl}/debug/state`)).json() as Promise<DebugState>;
  }

  async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await cond()) return;
      await sleep(20);
    }
  }

  /** Mo -> theo doi -> dong N ket noi lien tiep, tra ve tracked.size truoc/sau. */
  async function openAndCloseMany(n: number) {
    const before = (await state()).trackedSize;
    for (let i = 1; i <= n; i++) {
      const tab = await openTab();
      await track(tab, `stress-${i}`);
      tab.socket.disconnect();
    }
    await waitFor(async () => (await state()).connectedSockets === 0);
    const after = await state();
    return { before, after };
  }

  return { openTab, track, updateStatus, state, openAndCloseMany };
}

// ---------------------------------------------------------------------------
describe('BAN LOI (order.gateway.buggy.ts) - tai hien loi', () => {
  const t = setup('buggy');

  it('LOI 1: tab theo doi 2048 (va tab khong theo doi gi) van nhan su kien cua don 1024', async () => {
    const A = await t.openTab();
    const B = await t.openTab();
    const C = await t.openTab();
    await t.track(A, '1024');
    await t.track(B, '2048');

    await t.updateStatus('1024', 'SHIPPED');

    expect(A.received).toEqual([{ orderId: '1024', status: 'SHIPPED' }]);
    expect(B.received).toEqual([{ orderId: '1024', status: 'SHIPPED' }]); // RO RI
    expect(C.received).toEqual([{ orderId: '1024', status: 'SHIPPED' }]); // RO RI
  });

  it('LOI 2: mo roi dong 50 ket noi -> tracked con nguyen 50 entry rac', async () => {
    const { before, after } = await t.openAndCloseMany(50);

    expect(after.connectedSockets).toBe(0);
    expect(after.trackedSize - before).toBe(50); // RO RI BO NHO
  });

  it('LOI 3: 1 tab theo doi 1024 roi 2048 -> don 1024 bi ghi de', async () => {
    const A = await t.openTab();
    await t.track(A, '1024');
    await t.track(A, '2048');

    expect((await t.state()).tracked[A.socket.id!]).toEqual(['2048']); // mat 1024
  });
});

// ---------------------------------------------------------------------------
describe('BAN DA VA (order.gateway.ts)', () => {
  const t = setup('fixed');

  it('TC1: chi tab theo doi 1024 nhan su kien 1024; tab 2048 va tab khong theo doi thi khong', async () => {
    const A = await t.openTab();
    const B = await t.openTab();
    const C = await t.openTab();
    await t.track(A, '1024');
    await t.track(B, '2048');

    await t.updateStatus('1024', 'SHIPPED');
    expect(A.received).toEqual([{ orderId: '1024', status: 'SHIPPED' }]);
    expect(B.received).toEqual([]);
    expect(C.received).toEqual([]);

    await t.updateStatus('2048', 'PACKING');
    expect(A.received).toHaveLength(1);
    expect(B.received).toEqual([{ orderId: '2048', status: 'PACKING' }]);
    expect(C.received).toEqual([]);
  });

  it('TC2: mo roi dong 50 ket noi -> tracked va room ve rong', async () => {
    const { before, after } = await t.openAndCloseMany(50);

    expect(before).toBe(0);
    expect(after.connectedSockets).toBe(0);
    expect(after.trackedSize).toBe(0);
    expect(after.tracked).toEqual({});
    expect(after.orderRooms).toEqual({});
  });

  it('TC3: 1 tab theo doi 2 don -> nhan du ca 2', async () => {
    const A = await t.openTab();
    await t.track(A, '1024');
    await t.track(A, '2048');

    await t.updateStatus('1024', 'SHIPPED');
    await t.updateStatus('2048', 'DELIVERED');

    expect(A.received).toEqual([
      { orderId: '1024', status: 'SHIPPED' },
      { orderId: '2048', status: 'DELIVERED' },
    ]);
  });

  it('TC4: 2 tab cung theo doi 1024 (dien thoai + laptop) -> ca 2 deu nhan', async () => {
    const phone = await t.openTab();
    const laptop = await t.openTab();
    await t.track(phone, '1024');
    await t.track(laptop, '1024');
    expect((await t.state()).orderRooms).toEqual({ 'order:1024': 2 });

    await t.updateStatus('1024', 'SHIPPED');

    expect(phone.received).toHaveLength(1);
    expect(laptop.received).toHaveLength(1);
  });

  it('TC5: bo theo doi (order:untrack) -> khong nhan nua, state duoc don', async () => {
    const A = await t.openTab();
    await t.track(A, '1024');
    await A.socket.emitWithAck('order:untrack', '1024');

    await t.updateStatus('1024', 'SHIPPED');

    expect(A.received).toEqual([]);
    const s = await t.state();
    expect(s.trackedSize).toBe(0);
    expect(s.orderRooms).toEqual({});
  });

  it('TC6: orderId khong hop le bi tu choi va khong de lai trang thai', async () => {
    const A = await t.openTab();

    for (const bad of [undefined, '', '   ', { id: 1 }, '../1024']) {
      expect(await t.track(A, bad)).toMatchObject({ ok: false });
    }
    expect(await t.track(A, 1024)).toEqual({ ok: true, orderId: '1024' }); // so -> chuan hoa thanh chuoi

    expect((await t.state()).tracked).toEqual({ [A.socket.id!]: ['1024'] });
  });
});
