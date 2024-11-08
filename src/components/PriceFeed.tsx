import React from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';

const PriceFeed: React.FC = () => {
  const prices = useSelector((state: RootState) => state.priceFeed);

  return (
    <div className="scrolling-ticker">
      <div className="scrolling-ticker-content">
        {Object.entries(prices).map(([asset, data]) => (
          <div key={asset} className="scrolling-price-item">
            <span className="font-semibold capitalize">
              {/* {data.name.replace(/-/g, ' ')} */}
              {data.symbol}
            </span>
            <span>${parseFloat(data.priceUsd).toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PriceFeed;
