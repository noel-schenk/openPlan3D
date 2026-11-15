<script lang="ts">
  import { t } from '$lib/i18n';
  import { currentProject, addFloor, setActiveFloor, viewMode } from '$lib/stores/project';
  import { orderedFloors } from '$lib/utils/floors';

  let entries = $derived(orderedFloors($currentProject?.floors ?? []));
  let activeIndex = $derived(entries.findIndex((e) => e.floor.id === $currentProject?.activeFloorId));
  let activeEntry = $derived(activeIndex >= 0 ? entries[activeIndex] : entries[0] ?? null);
  let canGoUp = $derived(activeIndex >= 0 && activeIndex < entries.length - 1);
  let canGoDown = $derived(activeIndex > 0);

  function goUp() {
    if (canGoUp) setActiveFloor(entries[activeIndex + 1].floor.id);
  }

  function goDown() {
    if (canGoDown) setActiveFloor(entries[activeIndex - 1].floor.id);
  }
</script>

{#if activeEntry}
  <div
    data-floor-switcher
    role="group"
    aria-label={$t('floorControls.switch')}
    class="absolute {$viewMode === '3d' ? 'top-16' : 'top-4'} right-3 z-30 flex flex-col items-center gap-1 bg-white/95 backdrop-blur-sm border border-gray-200 rounded-xl shadow-lg p-1.5 select-none"
  >
    <button
      type="button"
      onclick={() => addFloor()}
      title={$t('floorControls.addAbove')}
      aria-label={$t('floorControls.addAbove')}
      class="w-8 h-7 rounded-lg flex items-center justify-center text-sm font-semibold text-blue-600 hover:bg-blue-50 active:bg-blue-100 transition-colors"
    >+</button>

    <button
      type="button"
      onclick={goUp}
      disabled={!canGoUp}
      title={$t('floorControls.up')}
      aria-label={$t('floorControls.up')}
      class="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors {canGoUp ? 'border-gray-200 bg-white text-gray-700 hover:bg-gray-100 hover:text-gray-900 active:bg-gray-200' : 'border-transparent text-gray-300 cursor-not-allowed'}"
    >
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="18 15 12 9 6 15" />
      </svg>
    </button>

    <div
      class="w-8 py-1 rounded-md bg-slate-100 text-center leading-tight"
      title={`${activeEntry.floor.name} (${$t('floorControls.current')})`}
    >
      <div class="text-xs font-bold text-slate-800">L{activeEntry.level}</div>
      <div class="text-[10px] font-medium text-slate-500">{activeIndex + 1}/{entries.length}</div>
    </div>

    <button
      type="button"
      onclick={goDown}
      disabled={!canGoDown}
      title={$t('floorControls.down')}
      aria-label={$t('floorControls.down')}
      class="w-8 h-8 rounded-lg flex items-center justify-center border transition-colors {canGoDown ? 'border-gray-200 bg-white text-gray-700 hover:bg-gray-100 hover:text-gray-900 active:bg-gray-200' : 'border-transparent text-gray-300 cursor-not-allowed'}"
    >
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  </div>
{/if}
