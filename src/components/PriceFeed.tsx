// src/components/PriceFeed.tsx
import React, { useEffect } from 'react';
import { useSelector } from 'react-redux';
import Carousel from 'react-multi-carousel';
import 'react-multi-carousel/lib/styles.css';
import { RootState } from '../redux/store';
import { FaBitcoin, FaEthereum } from 'react-icons/fa';

const responsive = {
  superLargeDesktop: { breakpoint: { max: 4000, min: 3000 }, items: 5 },
  desktop:           { breakpoint: { max: 3000, min: 1024 }, items: 3 },
  tablet:            { breakpoint: { max: 1024, min: 464  }, items: 2 },
  mobile:            { breakpoint: { max: 464,  min: 0    }, items: 1 },
};

const ASSETS = ['BTC', 'BCH', 'ETH'] as const;

const getLogo = (symbol: string) => {
  switch (symbol) {
    case 'BTC': return <FaBitcoin className="text-orange-500 text-3xl mr-3" />;
    case 'BCH': return <FaBitcoin className="text-green-500  text-3xl mr-3" />;
    case 'ETH': return <FaEthereum className="text-blue-500   text-3xl mr-3" />;
    default:    return null;
  }
};

const PriceFeed: React.FC = () => {
  const prices = useSelector((s: RootState) => s.priceFeed);

  // Log the entire prices object whenever it changes
  useEffect(() => {
    // console.group('[PriceFeed] Current rates from Redux:');
    // console.log(prices);
    // console.groupEnd();
  }, [prices]);

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
        removeArrowOnDeviceType={['tablet','mobile']}
        showDots={false}
      >
        {ASSETS.map((symbol) => {
          const rate = prices[symbol];

          // Log per-symbol rate as well
          // console.log(`[PriceFeed] rate[${symbol}] =`, rate);

          const display =
            rate != null
              ? `$${Number(rate).toFixed(2)}`
              : 'Loading…';

          return (
            <div
              key={symbol}
              className="scrolling-price-item bg-white px-6 py-12 rounded-lg shadow-lg flex items-center space-x-4 mx-4"
            >
              {getLogo(symbol)}
              <div className="flex-1">
                <span className="font-semibold text-lg capitalize text-gray-800">
                  {symbol}
                </span>
                <div className="text-gray-600 text-xl">
                  {display}
                </div>
                <span className="text-gray-500 text-sm">USD</span>
              </div>
            </div>
          );
        })}
      </Carousel>
    </div>
  );
};

export default PriceFeed;
