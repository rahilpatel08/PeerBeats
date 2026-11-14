import { useContributor } from '../store/contributor';

/**
 * Wi-Fi and battery details are only offered by some browsers, mainly Chrome on Android. iPhones
 * offer neither. Where a browser can't say, the option is shown as unavailable: never pretended.
 */
interface BatteryLike extends EventTarget {
  level: number;
  charging: boolean;
}

const LOW_BATTERY = 0.2;

const connection = () => (navigator as any).connection as (EventTarget & { type?: string }) | undefined;

let batteryPromise: Promise<BatteryLike | null> | null = null;
const battery = () => {
  const nav = navigator as any;
  batteryPromise ??= nav.getBattery ? nav.getBattery().catch(() => null) : Promise.resolve(null);
  return batteryPromise as Promise<BatteryLike | null>;
};

export async function conditionSupport() {
  return { wifi: typeof connection()?.type === 'string', battery: Boolean(await battery()) };
}

export async function blockingCondition(): Promise<'mobile-data' | 'low-battery' | null> {
  const { wifiOnly, stopOnLowBattery } = useContributor.getState();
  if (wifiOnly && connection()?.type === 'cellular') return 'mobile-data';
  if (stopOnLowBattery) {
    const b = await battery();
    if (b && !b.charging && b.level < LOW_BATTERY) return 'low-battery';
  }
  return null;
}

export function watchConditions(onChange: () => void) {
  connection()?.addEventListener?.('change', onChange);
  battery().then((b) => {
    b?.addEventListener('levelchange', onChange);
    b?.addEventListener('chargingchange', onChange);
  });
}
