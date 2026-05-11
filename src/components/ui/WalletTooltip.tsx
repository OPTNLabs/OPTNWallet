type WalletTooltipProps = {
  id: string;
  content: string;
  place?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
  clickable?: boolean;
};

export default function WalletTooltip({
  id,
  content,
  place = 'top',
  className,
  clickable = false,
}: WalletTooltipProps) {
  void id;
  void content;
  void place;
  void className;
  void clickable;
  return null;
}
