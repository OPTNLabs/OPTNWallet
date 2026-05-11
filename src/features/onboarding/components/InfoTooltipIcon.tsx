type InfoTooltipIconProps = {
  id: string;
  content: string;
  className?: string;
  iconClassName?: string;
  ariaLabel?: string;
};

const InfoTooltipIcon = ({
  id,
  content,
  className =
    'max-w-[80vw] whitespace-normal break-words text-sm leading-snug font-normal',
  iconClassName = 'cursor-pointer wallet-accent-icon text-lg font-bold select-none',
  ariaLabel = 'More information',
}: InfoTooltipIconProps) => {
  void id;
  void content;
  void className;
  void iconClassName;
  void ariaLabel;
  return null;
};

export default InfoTooltipIcon;
