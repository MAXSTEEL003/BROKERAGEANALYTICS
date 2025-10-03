import React, { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import './App.css';
import { db } from './firebase';
import {
  collection,
  getDocs,
  setDoc,
  doc,
  updateDoc,
  onSnapshot,
  deleteDoc,
  getFirestore,
} from "firebase/firestore";

function App() {
  // Export table to Excel (must be inside App to access state)
  const handleExport = () => {
    const filtered = buyers
      .filter(b => (!buyerFilter || b.buyer === buyerFilter) && (!placeFilter || b.place === placeFilter));
    const exportData = filtered.map((b, idx) => ({
      'SL No': idx + 1,
      'Buyer Name': b.buyer,
      'Place': b.place,
      'Total Qtls': b.totalQtls,
      'Commission Amount': b.commission.toFixed(2),
      'Received Amount': editable[b.buyer]?.receivedAmount || '',
      'Chq/RTGS/Cash': editable[b.buyer]?.paymentMode || ''
    }));
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Buyers');
    XLSX.writeFile(wb, 'buyers_summary.xlsx');
  };
  const [data, setData] = useState([]);
  const [buyers, setBuyers] = useState([]);
  const [error, setError] = useState('');
  const [headers, setHeaders] = useState([]);
  const [buyerFilter, setBuyerFilter] = useState('');
  const [placeFilter, setPlaceFilter] = useState('');
  const [editable, setEditable] = useState({}); // {buyer: {receivedAmount, paymentMode, locked}}
  // Load buyers from Firestore on mount and on change
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'buyers'), (snapshot) => {
      const arr = [];
      const editObj = {};
      snapshot.forEach(docSnap => {
        const d = docSnap.data();
        arr.push(d);
        editObj[d.buyer] = {
          receivedAmount: d.receivedAmount || '',
          paymentMode: d.paymentMode || '',
          locked: false
        };
      });
      setBuyers(arr);
      setEditable(editObj);
    });
    return () => unsub();
  }, []);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const bstr = evt.target.result;
      try {
        const wb = XLSX.read(bstr, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const jsonData = XLSX.utils.sheet_to_json(ws, { defval: '' });
        setData(jsonData);
        if (jsonData.length > 0) {
          setHeaders(Object.keys(jsonData[0]));
        } else {
          setHeaders([]);
        }
        processBuyers(jsonData);
        setError('');
      } catch (err) {
        setError('Invalid Excel file or format.');
      }
    };
    reader.readAsBinaryString(file);
  };

  // Save imported buyers to Firestore (overwrites existing)
  const processBuyers = async (rows) => {
    const buyersMap = {};
    rows.forEach(row => {
      const buyer = row['BUYER NAMER']?.toString().trim();
      const qtls = parseFloat(row['qtls'] || 0);
      const amount = parseFloat(row['Amount'] || 0);
      const miller = (row['MILLER NAME'] || '').toString().toLowerCase();
      const place = row['PLACE']?.toString().trim() || '';
      if (!buyer) return;
      if (!buyersMap[buyer]) {
        buyersMap[buyer] = { buyer, totalQtls: 0, commission: 0, place };
      }
      buyersMap[buyer].totalQtls += isNaN(qtls) ? 0 : qtls;
      // Commission calculation
      if (miller.includes('nidhiagros')) {
        buyersMap[buyer].commission += isNaN(amount) ? 0 : amount * 0.01;
      } else {
        buyersMap[buyer].commission += isNaN(qtls) ? 0 : qtls * 11;
      }
      if (place) buyersMap[buyer].place = place;
    });
    // Save each buyer to Firestore (merge: true to keep manual fields)
    for (const b of Object.values(buyersMap)) {
      await setDoc(doc(db, 'buyers', b.buyer), b, { merge: true });
    }
  };

  // Handler to clear DB and upload new file
  const handleFileUploadWithClear = async (e) => {
    if (!e.target.files[0]) return;
    if (!window.confirm('This will delete all previous buyer data. Continue?')) return;
    await clearAllBuyers();
    handleFileUpload(e);
  };

  // Utility to clear all buyers from Firestore
  async function clearAllBuyers() {
    const querySnapshot = await getDocs(collection(db, 'buyers'));
    const batch = [];
    querySnapshot.forEach((docSnap) => {
      batch.push(deleteDoc(doc(db, 'buyers', docSnap.id)));
    });
    await Promise.all(batch);
  }

  return (
    <div className="App">
      <h2>Excel Importer: Buyer Summary</h2>
      <button
        className="danger-btn"
        style={{ marginBottom: 18 }}
        onClick={async () => {
          if (window.confirm('This will permanently delete ALL buyer data from the database. Are you sure?')) {
            await clearAllBuyers();
            alert('All buyer data deleted!');
          }
        }}
      >
        CLEAR ALL DATA (DANGER)
      </button>
      <div className="file-upload-container">
        <input type="file" accept=".xlsx, .xls" onChange={handleFileUploadWithClear} />
        {error && <div className="error-message">{error}</div>}
      </div>
      {/* Debug info: show detected headers and preview rows */}
      <div style={{ marginTop: 20 }}>
        {buyers.length > 0 && (
          <div>
            {/* Search and select for buyer name */}
            <div className="filters-container">
              <div className="filters-row">
                <div className="filter-group">
                  <label>Buyer Name</label>
                  <select
                    value={buyerFilter}
                    onChange={e => {
                      const val = e.target.value;
                      setBuyerFilter(val);
                      if (val) {
                        // Find the place for this buyer
                        const found = buyers.find(b => b.buyer === val);
                        if (found) setPlaceFilter(found.place || '');
                      } else {
                        setPlaceFilter('');
                      }
                    }}
                  >
                    <option value="">All</option>
                    {buyers.map(b => (
                      <option key={b.buyer} value={b.buyer}>{b.buyer}</option>
                    ))}
                  </select>
                </div>
                <div className="filter-group">
                  <label>Place</label>
                  <select value={placeFilter} onChange={e => setPlaceFilter(e.target.value)}>
                    <option value="">All</option>
                    {[...new Set(buyers.map(b => b.place).filter(Boolean))].map(place => (
                      <option key={place} value={place}>{place}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="table-container">
              <div style={{ overflowX: 'auto' }}>
                <table className="buyer-table">
                <thead>
                  <tr>
                    <th>SL No</th>
                    <th>Buyer Name</th>
                    <th>Place</th>
                    <th>Total Qtls</th>
                    <th>Commission Amount</th>
                    <th>Received Amount</th>
                    <th>Chq/RTGS/Cash</th>
                  </tr>
                </thead>
                <tbody>
                  {buyers
                    .filter(b => (!buyerFilter || b.buyer === buyerFilter) && (!placeFilter || b.place === placeFilter))
                    .map((b, idx) => {
                      const isLocked = editable[b.buyer]?.locked;
                      return (
                        <tr key={b.buyer}>
                          <td>{idx + 1}</td>
                          <td>{b.buyer}</td>
                          <td>{b.place}</td>
                          <td>{b.totalQtls}</td>
                          <td>{b.commission.toFixed(2)}</td>
                          <td>
                            <input
                              type="number"
                              style={{ width: 100 }}
                              value={editable[b.buyer]?.receivedAmount || ''}
                              onChange={e => setEditable(ed => ({ ...ed, [b.buyer]: { ...ed[b.buyer], receivedAmount: e.target.value } }))}
                              disabled={isLocked}
                              onBlur={async (e) => {
                                await updateDoc(doc(db, 'buyers', b.buyer), { receivedAmount: e.target.value });
                              }}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              style={{ width: 110 }}
                              value={editable[b.buyer]?.paymentMode || ''}
                              onChange={e => setEditable(ed => ({ ...ed, [b.buyer]: { ...ed[b.buyer], paymentMode: e.target.value } }))}
                              disabled={isLocked}
                              onBlur={async (e) => {
                                await updateDoc(doc(db, 'buyers', b.buyer), { paymentMode: e.target.value });
                              }}
                            />
                          </td>
                          <td>
                            {isLocked ? (
                              <button 
                                className="edit-btn"
                                onClick={() => setEditable(ed => ({ ...ed, [b.buyer]: { ...ed[b.buyer], locked: false } }))}
                              >
                                Edit
                              </button>
                            ) : (
                              <button 
                                className="save-edit-btn"
                                onClick={async () => {
                                  setEditable(ed => ({ ...ed, [b.buyer]: { ...ed[b.buyer], locked: true } }));
                                  await updateDoc(doc(db, 'buyers', b.buyer), {
                                    receivedAmount: editable[b.buyer]?.receivedAmount || '',
                                    paymentMode: editable[b.buyer]?.paymentMode || ''
                                  });
                                }}
                              >
                                Save
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* Export to Excel button only for the entire table, not per row */}
              <div style={{ textAlign: 'right' }}>
                <button onClick={handleExport} className="export-btn">
                  Export as Excel
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="footer-note">
          <small>Columns expected: buyer name, qtls, amount, seller</small>
        </div>
      </div>
    </div>
  );
}

export default App;
