import React from "react";
import { Link } from 'react-router-dom';

const NavBar = () => {
  return (
    <>
      <nav className="text-white p-4 side-margins">
        <div className="container mx-auto flex items-center justify-between">
          <div className="flex items-center">
            <li>
              <Link
                to="/"
                className="text-white px-3 py-2 rounded-md text-lg"
              >
                Home
              </Link>
            </li>
          </div>
          <ul className="hidden md:flex">
            <li>
              <Link
                to="/filler"
                className="text-white px-3 py-2 rounded-md text-lg"
              >
                Info
              </Link>
            </li>
            <li>
              <Link
                to="/filler"
                className="text-white px-3 py-2 rounded-md text-lg"
              >
                Filler
              </Link>
            </li>
            <li>
              <a
                to="/filler"
                className="text-white px-3 py-2 rounded-md text-lg"
              >
                Filler
              </a>
            </li>
          </ul>
        </div>
      </nav>
    </>
  );
};

export default NavBar;
