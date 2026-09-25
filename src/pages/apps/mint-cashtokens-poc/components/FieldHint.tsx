import React, { memo, useId, useState } from 'react';

/**
 * A "!" next to a field label that explains the field in a few words.
 *
 * Tapping toggles the text, because a hover title alone never shows on a
 * phone; the title is kept for desktop pointers. The hint is tied to the
 * button with aria-describedby so screen readers announce it too.
 */
const FieldHint: React.FC<{ label: string; hint: string }> = memo(
  ({ label, hint }) => {
    const [open, setOpen] = useState(false);
    const hintId = useId();
    return (
      <span className="inline-flex items-center gap-1 align-middle">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={`About ${label}`}
          aria-describedby={open ? hintId : undefined}
          title={hint}
          className="inline-flex h-4 w-4 items-center justify-center rounded-full wallet-surface-strong text-[10px] font-bold wallet-muted"
        >
          !
        </button>
        {open ? (
          <span
            id={hintId}
            role="note"
            className="text-[11px] font-normal wallet-muted"
          >
            {hint}
          </span>
        ) : null}
      </span>
    );
  }
);

FieldHint.displayName = 'FieldHint';

export default FieldHint;
