// src/components/PriceFeed.tsx
import React from 'react';
import { useSelector } from 'react-redux';
import Carousel from 'react-multi-carousel';
import 'react-multi-carousel/lib/styles.css';
import { RootState } from '../redux/store';
import { FaBitcoin, FaEthereum } from 'react-icons/fa';

const responsive = {
  superLargeDesktop: { breakpoint: { max: 4000, min: 3000 }, items: 5 },
  desktop: { breakpoint: { max: 3000, min: 1024 }, items: 3 },
  tablet: { breakpoint: { max: 1024, min: 464 }, items: 2 },
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

const PriceFeed: React.FC = () => {
  const prices = useSelector((s: RootState) => s.priceFeed);

  return (
    <div className="price-feed-carousel">
      <Carousel
        responsive={responsive}
        infinite
        autoPlay
        autoPlaySpeed={2000}
        keyBoardControl
        transitionDuration={500}
        containerClass="carousel-container"
        itemClass="carousel-item-padding-40-px"
        removeArrowOnDeviceType={['tablet', 'mobile']}
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
              className="scrolling-price-item wallet-card px-6 py-12 rounded-lg shadow-lg grid grid-cols-[auto,1fr,auto] items-center gap-x-4 mx-4"
            >
              {getLogo(symbol)}
              <div className="flex flex-col">
                <span className="font-semibold text-lg wallet-text-strong">
                  {symbol}
                </span>
                <span className="wallet-muted text-xs">USD</span>
              </div>
              <div className="flex flex-col items-end font-bold">
                <div className="wallet-text-strong text-xl">{display}</div>
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
