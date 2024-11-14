import React from 'react';
import { useSelector } from 'react-redux';
import Carousel from 'react-multi-carousel';
import 'react-multi-carousel/lib/styles.css';
import { RootState } from '../redux/store';
import { FaBitcoin, FaEthereum } from 'react-icons/fa';

const responsive = {
  superLargeDesktop: {
    breakpoint: { max: 4000, min: 3000 },
    items: 5,
  },
  desktop: {
    breakpoint: { max: 3000, min: 1024 },
    items: 3,
  },
  tablet: {
    breakpoint: { max: 1024, min: 464 },
    items: 2,
  },
  mobile: {
    breakpoint: { max: 464, min: 0 },
    items: 1,
  },
};

const PriceFeed: React.FC = () => {
  const prices = useSelector((state: RootState) => state.priceFeed);

  const getLogo = (symbol: string) => {
    switch (symbol) {
      case 'BTC':
        return <FaBitcoin className="text-orange-500 text-3xl mr-3" />;
      case 'BCH':
        return <FaBitcoin className="text-green-500 text-3xl mr-3" />;
      case 'ETH':
        return <FaEthereum className="text-blue-500 text-3xl mr-3" />;
      default:
        return null;
    }
  };

  return (
    <div className="price-feed-carousel">
      <Carousel
        responsive={responsive}
        infinite={true}
        autoPlay={true}
        autoPlaySpeed={2000}
        keyBoardControl={true}
        transitionDuration={500}
        containerClass="carousel-container"
        itemClass="carousel-item-padding-40-px"
        removeArrowOnDeviceType={['tablet', 'mobile']}
        showDots={false}
      >
        {Object.entries(prices).map(([asset, data]) => (
          <div
            key={asset}
            className="scrolling-price-item bg-white px-6 py-12 rounded-lg shadow-lg flex items-center space-x-4 mx-4"
          >
            <span className="font-semibold text-lg capitalize text-gray-800">
              {data.symbol}
            </span>
            {getLogo(data.symbol)}
            <div className="flex flex-col">
              <span className="text-gray-600 text-xl">
                ${parseFloat(data.priceUsd).toFixed(2)}
              </span>
              <span className="text-gray-500 text-sm">USD</span>
            </div>
            <span
              className={
                parseFloat(data.changePercent24Hr) < 0
                  ? 'text-red-500'
                  : 'text-green-500'
              }
            >
              <div className="flex flex-col">
                <span
                  className={
                    parseFloat(data.changePercent24Hr) < 0
                      ? 'text-red-500'
                      : 'text-green-500'
                  }
                >
                  {parseFloat(data.changePercent24Hr).toFixed(2)}%
                </span>
                <span className="text-gray-500 text-sm">24 hr</span>
              </div>
            </span>
          </div>
        ))}
      </Carousel>
    </div>
  );
};

export default PriceFeed;
