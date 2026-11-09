import { useState } from 'react';

type PersonalLabelEditorProps = {
  initialValue: string;
  fieldLabel: string;
  saveLabel: string;
  savingLabel: string;
  cancelLabel: string;
  errorLabel: string;
  onSave: (value: string) => Promise<void>;
  onCancel: () => void;
};

export default function PersonalLabelEditor({
  initialValue,
  fieldLabel,
  saveLabel,
  savingLabel,
  cancelLabel,
  errorLabel,
  onSave,
  onCancel,
}: PersonalLabelEditorProps) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await onSave(value);
    } catch {
      setError(errorLabel);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      <label className="block text-xs wallet-muted">
        {fieldLabel}
        <input
          autoFocus
          maxLength={200}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="wallet-input mt-1 w-full text-sm"
          aria-label={fieldLabel}
        />
      </label>
      {error && (
        <p className="text-xs wallet-danger-text" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={saving}
          className="wallet-btn-primary min-h-[44px] flex-1 px-3 py-2 text-sm disabled:opacity-50"
          onClick={() => void save()}
        >
          {saving ? savingLabel : saveLabel}
        </button>
        <button
          type="button"
          disabled={saving}
          className="wallet-btn-secondary min-h-[44px] flex-1 px-3 py-2 text-sm disabled:opacity-50"
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
