import { Tooltip } from 'react-tooltip';

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
  return (
    <>
      <span
        data-tooltip-id={id}
        className={iconClassName}
        aria-label={ariaLabel}
        role="img"
      >
        ⓘ
      </span>
      <Tooltip id={id} place="top" className={className} content={content} />
    </>
  );
};

export default InfoTooltipIcon;
