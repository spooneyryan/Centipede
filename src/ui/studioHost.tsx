// A thin React island: the rest of the game is plain DOM + canvas, and the
// only React on the page is GameBase's studio editors (the sprite pixel/vector
// editor and the sound-effect designer), mounted on demand. The host owns
// persistence — the editors hand back an edited copy on save and nothing on
// cancel, exactly the studio contract.

import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SfxStudio, SpriteStudio } from "@ccllc/studio";
import type { SfxDefinition } from "@ccllc/arcade/sfx";
import type { SpriteAsset } from "@ccllc/arcade/shmup";

type Job =
  | { kind: "sprite"; asset: SpriteAsset; onSave: (asset: SpriteAsset) => void }
  | { kind: "sfx"; sound: SfxDefinition; onApply: (sound: SfxDefinition) => void };

export interface StudioHost {
  editSprite(asset: SpriteAsset, onSave: (asset: SpriteAsset) => void): void;
  editSound(sound: SfxDefinition, onApply: (sound: SfxDefinition) => void): void;
  readonly busy: boolean;
}

export function createStudioHost(container: HTMLElement): StudioHost {
  let root: Root | null = null;
  let setJob: ((job: Job | null) => void) | null = null;
  let currentJob: Job | null = null;

  function Host(): React.JSX.Element | null {
    const [job, set] = useState<Job | null>(currentJob);
    setJob = (next) => {
      currentJob = next;
      set(next);
    };
    if (!job) return null;
    const close = () => setJob?.(null);
    if (job.kind === "sprite") {
      return (
        <SpriteStudio
          asset={job.asset}
          onSave={(asset) => {
            job.onSave(asset);
            close();
          }}
          onCancel={close}
        />
      );
    }
    return (
      <SfxStudio
        sound={job.sound}
        onApply={(sound) => {
          job.onApply(sound);
          close();
        }}
        onCancel={close}
      />
    );
  }

  function open(job: Job): void {
    if (root && setJob) {
      setJob(job);
      return;
    }
    // First open — or a previous render crashed before Host could hand back
    // its setter, in which case the old root is dead weight: replace it.
    root?.unmount();
    root = createRoot(container);
    currentJob = job;
    root.render(<Host />);
  }

  return {
    editSprite: (asset, onSave) => open({ kind: "sprite", asset: structuredClone(asset), onSave }),
    editSound: (sound, onApply) => open({ kind: "sfx", sound: structuredClone(sound), onApply }),
    get busy() {
      return currentJob !== null;
    },
  };
}
