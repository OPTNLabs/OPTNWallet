// src/components/PriceFeed.tsx
import React from 'react';
import { useSelector } from 'react-redux';
import Carousel from 'react-multi-carousel';
import 'react-multi-carousel/lib/styles.css';
import { RootState } from '../state/store';
import { FaBitcoin, FaEthereum } from 'react-icons/fa';

// Desktop renders the wallet as a fixed ~480px centered column at any window size, so the
// price ticker should always show a single card (the look that fits the column). The
// carousel keys off window width, so every breakpoint is set to 1 to stay consistent when
// the window is enlarged/maximized.
const responsive = {
  superLargeDesktop: { breakpoint: { max: 4000, min: 3000 }, items: 1 },
  desktop: { breakpoint: { max: 3000, min: 1024 }, items: 1 },
  tablet: { breakpoint: { max: 1024, min: 464 }, items: 1 },
  mobile: { breakpoint: { max: 464, min: 0 }, items: 1 },
};

const ASSETS = ['BTC', 'BCH', 'ETH'] as const;

const getLogo = (symbol: string) => {
  switch (symbol) {
    case 'BTC':
      return <FaBitcoin className="wallet-coin-btc text-3xl mr-3" />;
    case 'BCH':
      return <FaBitcoin className="wallet-accent-icon text-3xl mr-3" />;
    case 'ETH':
      return <FaEthereum className="wallet-coin-eth text-3xl mr-3" />;
    default:
      return null;
  }
};

const fmtUSD = (n: number) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

type PriceFeedProps = {
  compact?: boolean;
};

const PriceFeed: React.FC<PriceFeedProps> = ({ compact = false }) => {
  const prices = useSelector((s: RootState) => s.priceFeed);

  return (
    <div className="price-feed-carousel">
      <Carousel
        responsive={responsive}
        infinite
        autoPlay
        autoPlaySpeed={7000}
        keyBoardControl
        transitionDuration={500}
        containerClass="carousel-container"
        itemClass="carousel-item-padding-40-px"
        removeArrowOnDeviceType={[]}
        showDots={false}
      >
        {ASSETS.map((symbol) => {
          const key = `${symbol}-USD`;
          const datum = prices[key];
          const display = datum ? `$${fmtUSD(datum.price)}` : 'Loading…';
          // const meta = datum
          //   ? `${datum.source}${
          //       datum.ts
          //         ? ` • ${Math.max(0, Math.floor((Date.now() - datum.ts) / 1000))}s`
          //         : ''
          //     }`
          //   : '—';

          return (
          <div
            key={symbol}
            className={`scrolling-price-item wallet-card rounded-lg shadow-lg grid grid-cols-[auto,1fr,auto] items-center gap-x-4 mx-4 ${
              compact ? 'px-3 py-2.5' : 'px-6 py-12'
            }`}
          >
              {getLogo(symbol)}
              <div className="flex flex-col">
                <span className={`${compact ? 'text-xs' : 'text-lg'} font-semibold wallet-text-strong`}>
                  {symbol}
                </span>
                <span className={`${compact ? 'text-[10px]' : 'text-xs'} wallet-muted`}>USD</span>
              </div>
              <div className="flex flex-col items-end font-bold">
                <div className={`${compact ? 'text-sm' : 'text-xl'} wallet-text-strong`}>{display}</div>
                {/* <span className="wallet-muted text-xs">{meta}</span> */}
              </div>
            </div>
          );
        })}
      </Carousel>
    </div>
  );
};

export default PriceFeed;
