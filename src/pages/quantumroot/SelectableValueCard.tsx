import React from 'react';
import { QRCodeSVG } from 'qrcode.react';

type SelectableValueCardProps = {
  label: string;
  value: string;
  onCopy: (value: string) => void;
  qrValue?: string;
  helperText?: React.ReactNode;
  copyLabel?: string;
};

const SelectableValueCard: React.FC<SelectableValueCardProps> = ({
  label,
  value,
  onCopy,
  qrValue,
  helperText,
  copyLabel = 'Copy',
}) => {
  return (
    <div className="wallet-surface-strong rounded-[14px] p-3">
      <div className="text-[11px] font-semibold wallet-muted mb-1">{label}</div>
      {qrValue ? (
        <div className="flex items-center justify-center mb-3">
          <div className="rounded-2xl bg-white p-1 shadow-sm border border-[rgba(0,0,0,0.08)]">
            <QRCodeSVG
              value={qrValue}
              size={144}
              bgColor="#ffffff"
              fgColor="#000000"
              level="H"
              marginSize={1}
              imageSettings={{
                src: '/assets/images/OPTNUIkeyline.png',
                height: 28,
                width: 28,
                excavate: true,
              }}
            />
          </div>
        </div>
      ) : null}
      <div className="text-sm break-all select-text">{value}</div>
      <button
        className="wallet-btn-secondary w-full mt-3"
        onClick={() => onCopy(value)}
      >
        {copyLabel}
      </button>
      {helperText ? <div className="text-[11px] wallet-muted mt-2">{helperText}</div> : null}
    </div>
  );
};

export default SelectableValueCard;
