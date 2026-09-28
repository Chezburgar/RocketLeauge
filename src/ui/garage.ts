import { anthems } from '../audio/anthems';
import { BODY_NAMES, TOPPER_NAMES, WHEEL_NAMES } from '../render/carModel';
import { BOOST_NAMES, EXPLOSION_NAMES } from '../render/effects';
import { TEAM_SHADES, type BodyId, type BoostId, type ExplosionId, type Loadout, type TopperId, type WheelId } from '../game/types';
import { btn, clear, h } from './dom';

type Cat = 'body' | 'paint' | 'wheels' | 'boost' | 'explosion' | 'anthem' | 'topper';

const ACCENTS = [0xdedede, 0x202226, 0x7a7f8c, 0xffd23b, 0xff9a2a, 0xff3b3b, 0xff3b9d, 0xb03bff, 0x5b4bff, 0x3bb6ff, 0x3bffd8, 0x3bff8a, 0x9dff3b, 0x8a5a2b, 0xf5e6c8, 0x00ff66];

const ICONS: Record<string, string> = {
  breaker: '🏎', wedge: '🔻', titan: '🚙', viper: '🛩',
  classic: '⚙', spoke: '✳', turbine: '🌀', neon: '⭕', star: '⭐',
  flame: '🔥', plasma: '🟣', sparkle: '✨', bubbles: '🫧', lightning: '⚡', rainbow: '🌈',
  fireworks: '🎆', singularity: '🕳', electro: '⚡', confetti: '🎉', voxel: '🧊', shockwave: '💥', inferno: '🌋',
  none: '—', cone: '🚧', crown: '👑', halo: '😇', antenna: '📡', horns: '🦄',
};

export interface GarageHooks {
  loadout: Loadout;
  onChange: (l: Loadout) => void;
  onPreviewTeam: (team: number) => void;
  onTestExplosion: () => void;
  onPlayAnthem: (id: string) => void;
  onBack: () => void;
}

export function buildGarage(hooks: GarageHooks): HTMLElement {
  let cat: Cat = 'body';
  let team = 0;
  const l = hooks.loadout;
  const tabs = h('div', { class: 'tabs' });
  const items = h('div', { class: 'items' });
  const actions = h('div', { class: 'garage-actions' });
  const panel = h('div', { class: 'card garage-panel' }, tabs, items, actions);

  const set = <K extends keyof Loadout>(k: K, v: Loadout[K]) => {
    l[k] = v;
    hooks.onChange({ ...l });
    render();
  };

  const grid = <T extends string>(names: Record<T, string>, key: 'body' | 'wheels' | 'boost' | 'explosion' | 'topper') => {
    for (const id of Object.keys(names) as T[]) {
      items.appendChild(
        h('div', { class: 'item' + (l[key] === id ? ' on' : ''), onClick: () => set(key, id as never) },
          h('div', { class: 'em' }, ICONS[id] ?? '•'), h('div', null, names[id])),
      );
    }
  };

  const render = () => {
    clear(tabs);
    const cats: [Cat, string][] = [
      ['body', 'Body'], ['paint', 'Paint'], ['wheels', 'Wheels'], ['boost', 'Boost'],
      ['explosion', 'Goal Explosion'], ['anthem', 'Anthem'], ['topper', 'Topper'],
    ];
    for (const [id, label] of cats)
      tabs.appendChild(h('div', { class: 'tab' + (cat === id ? ' active' : ''), onClick: () => { cat = id; render(); } }, h('span', null, label)));
    clear(items);
    clear(actions);
    items.style.display = 'grid';
    switch (cat) {
      case 'body':
        grid<BodyId>(BODY_NAMES, 'body');
        break;
      case 'wheels':
        grid<WheelId>(WHEEL_NAMES, 'wheels');
        break;
      case 'boost':
        grid<BoostId>(BOOST_NAMES, 'boost');
        actions.appendChild(h('div', { class: 'small' }, 'Tip: your boost trail shows in-game when you boost.'));
        break;
      case 'explosion':
        grid<ExplosionId>(EXPLOSION_NAMES, 'explosion');
        actions.appendChild(btn('💥 Test explosion', hooks.onTestExplosion, 'orange sm'));
        break;
      case 'topper':
        grid<TopperId>(TOPPER_NAMES, 'topper');
        break;
      case 'anthem':
        for (const a of anthems()) {
          items.appendChild(
            h('div', { class: 'item' + (l.anthem === a.id ? ' on' : ''), style: 'grid-column: span 2', onClick: () => { set('anthem', a.id); if (a.id !== 'none') hooks.onPlayAnthem(a.id); } },
              h('div', { class: 'em' }, a.id === 'none' ? '🔇' : a.custom ? '🎵' : '🎺'), h('div', null, a.name)),
          );
        }
        actions.append(btn('▶ Play selected', () => l.anthem !== 'none' && hooks.onPlayAnthem(l.anthem), 'sm'), h('div', { class: 'small' }, 'Your anthem plays for everyone when you score.'));
        break;
      case 'paint': {
        items.style.display = 'block';
        const shades = h('div', { class: 'swatches' });
        TEAM_SHADES[team as 0 | 1].forEach((c, i) =>
          shades.appendChild(h('div', { class: 'swatch' + (l.shade === i ? ' on' : ''), style: `background:#${c.toString(16).padStart(6, '0')}`, onClick: () => set('shade', i) })));
        const acc = h('div', { class: 'swatches' });
        for (const c of ACCENTS)
          acc.appendChild(h('div', { class: 'swatch' + (l.accent === c ? ' on' : ''), style: `background:#${c.toString(16).padStart(6, '0')}`, onClick: () => set('accent', c) }));
        const custom = h('input', { type: 'color', value: '#' + l.accent.toString(16).padStart(6, '0'), style: 'width:60px;height:40px;border:none;background:none;cursor:pointer' }) as HTMLInputElement;
        custom.addEventListener('input', () => set('accent', parseInt(custom.value.slice(1), 16)));
        items.append(
          h('h3', { style: 'margin:4px 0 8px' }, 'Primary (team shade)'), shades,
          h('p', { class: 'small' }, 'Your body is always painted in your team\'s colour – pick the shade.'),
          h('h3', { style: 'margin:16px 0 8px' }, 'Accent'), acc,
          h('div', { class: 'row', style: 'justify-content:flex-start;margin-top:10px' }, h('span', { class: 'small' }, 'Custom:'), custom),
        );
        break;
      }
    }
  };
  render();

  const teamBtn = h('div', { class: 'team-toggle row' },
    btn('Blue', () => { team = 0; hooks.onPreviewTeam(0); render(); }, 'sm'),
    btn('Orange', () => { team = 1; hooks.onPreviewTeam(1); render(); }, 'orange sm'),
  );

  return h('div', { id: 'garage', class: 'screen' },
    h('div', { class: 'sub-head', style: 'position:absolute;left:3vw;top:4vh' }, btn('◀ Back', hooks.onBack, 'ghost sm back'), h('h2', null, 'GARAGE')),
    panel,
    teamBtn,
  );
}
