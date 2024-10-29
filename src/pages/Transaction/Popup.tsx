function Popup({ closePopups, children }) {
  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center">
      <div className="bg-white p-6 rounded shadow-lg w-full max-w-md max-h-[90vh] overflow-hidden">
        {children}
        <button
          className="bg-gray-300 text-gray-700 py-2 px-4 rounded mt-4"
          onClick={closePopups}
        >
          Close
        </button>
      </div>
    </div>
  );
}
export default Popup;
