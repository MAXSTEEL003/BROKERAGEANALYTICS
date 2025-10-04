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
      // prefer DB stored date (dd/mm/yyyy), fall back to editable input converted to DB format
      'Date': b.date || (editable[b.buyer]?.date ? toDbDate(editable[b.buyer].date) : ''),
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
  const [detectedKeys, setDetectedKeys] = useState(null);
  // Date helpers: display (input) uses yyyy-mm-dd, DB should store dd/mm/yyyy per requirement
  const toDbDate = (inputDate) => {
    if (!inputDate) return '';
    // if already in dd/mm/yyyy format, return as-is
    if (inputDate.includes('/')) return inputDate;
    // expect yyyy-mm-dd from <input type="date">
    const parts = String(inputDate).split('-');
    if (parts.length !== 3) return inputDate;
    const [y, m, d] = parts;
    return `${d}/${m}/${y}`;
  };

  const toInputDate = (dbDate) => {
    if (!dbDate) return '';
    // if already in yyyy-mm-dd format, return as-is
    if (dbDate.includes('-')) return dbDate;
    // expect dd/mm/yyyy in DB
    const parts = String(dbDate).split('/');
    if (parts.length !== 3) return dbDate;
    const [d, m, y] = parts;
    // pad to ensure two-digit month/day
    const dd = d.padStart(2, '0');
    const mm = m.padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  };

  // Format qtls to avoid long recurring decimals. Behavior:
  // - Integers show without decimals
  // - If decimal part appears to be a repeating single digit (e.g. .333333 or .666666), show one decimal place (1.3, 1.6)
  // - Otherwise show up to 2 decimal places, trimming trailing zeros
  const formatQtls = (val) => {
    if (val === undefined || val === null || val === '') return '';
    const num = Number(val);
    if (Number.isNaN(num)) return String(val);
    if (Number.isInteger(num)) return String(num);
    // Work with fixed 6 decimal places to detect repetition
    const fixed = num.toFixed(6);
    const [intPart, decPartRaw] = fixed.split('.');
    const decPart = decPartRaw.replace(/0+$/,''); // trim trailing zeros
    if (!decPart) return intPart;
    // detect repeating same digit across the (trimmed) decimal part (length >=3)
    const isRepeating = decPart.length >= 3 && /^([0-9])\1+$/.test(decPart);
    if (isRepeating) return `${intPart}.${decPart[0]}`;
    // otherwise, show up to 2 decimals (remove trailing zeros)
    return parseFloat(String(num.toFixed(2))).toString();
  };
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
          // convert DB date (dd/mm/yyyy) into input-friendly yyyy-mm-dd
          date: toInputDate(d.date || ''),
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
    if (!rows || rows.length === 0) return;

    // Build header lookup from the first row (case-insensitive)
    const firstRow = rows[0] || {};
    const keys = Object.keys(firstRow);
    const lowerKeys = keys.map(k => k.toLowerCase());

    const findKey = (candidates, preferExact = false) => {
      // preferExact: try exact match first (useful for PLACE since you insisted it's exact)
      for (const cand of candidates) {
        if (preferExact) {
          const idxExact = lowerKeys.findIndex(k => k === cand);
          if (idxExact !== -1) return keys[idxExact];
        }
        const idx = lowerKeys.findIndex(k => k.includes(cand));
        if (idx !== -1) return keys[idx];
      }
      return null;
    };

  const buyerKey = findKey(['buyer', 'buyer name', 'buyername', 'buyer namer']);
    const qtlsKey = findKey(['qtls', 'qtl', 'qty', 'quantity']);
    const amountKey = findKey(['amount', 'amt', 'price', 'total amount']);
    const millerKey = findKey(['miller', 'miller name', 'seller', 'broker']);
    // For PLACE the user said there's only one heading named PLACE, prefer exact
    const placeKey = findKey(['place', 'location', 'city'], true) || findKey(['place', 'location', 'city']);

  // Expose detected keys for debugging in the UI
  try { setDetectedKeys({ buyerKey, qtlsKey, amountKey, millerKey, placeKey }); } catch (e) { /* ignore during tests */ }

    const parseNumber = (val) => {
      if (val === undefined || val === null || val === '') return NaN;
      const s = String(val).replace(/[\s,\u20B9\$]/g, '').replace(/[()]/g, '');
      const cleaned = s.replace(/[^0-9.\-]/g, '');
      return parseFloat(cleaned);
    };

    const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    rows.forEach(row => {
      const buyer = buyerKey ? String(row[buyerKey] || '').trim() : '';
      const qtls = qtlsKey ? parseNumber(row[qtlsKey]) : NaN;
      const amount = amountKey ? parseNumber(row[amountKey]) : NaN;
      const millerRaw = millerKey ? String(row[millerKey] || '') : '';
      const miller = normalize(millerRaw);
      const place = placeKey ? String(row[placeKey] || '').trim() : '';

      if (!buyer) return; // skip rows without buyer

      if (!buyersMap[buyer]) {
        buyersMap[buyer] = { buyer, totalQtls: 0, commission: 0 };
      }

      buyersMap[buyer].totalQtls += isNaN(qtls) ? 0 : qtls;

      // Flexible matching for nidhi/nihi agros variants
      const isNidhiAgros = (() => {
        if (!miller) return false;
        // check combinations like 'nidhi' + 'agro' in any order and tolerate typos like 'nihi'
        if (/nidhi/.test(miller) && /agro/.test(miller)) return true;
        if (/nihi/.test(miller) && /agro/.test(miller)) return true;
        if (miller.includes('nidhiagros') || miller.includes('nihiagros') || miller.includes('nidhiagro')) return true;
        return false;
      })();

      if (isNidhiAgros) {
        buyersMap[buyer].commission += isNaN(amount) ? 0 : amount * 0.01; // 1% of amount
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
        {/* Debug panel */}
        {detectedKeys && (
          <div style={{ marginBottom: 12, padding: 8, border: '1px solid #ddd' }}>
            <strong>Debug:</strong>
            <div>Headers: {JSON.stringify(headers)}</div>
            <div>Detected keys: {JSON.stringify(detectedKeys)}</div>
            <div style={{ maxHeight: 120, overflow: 'auto' }}>Editable state preview: {JSON.stringify(Object.keys(editable).slice(0,10))}</div>
            <div>Data rows preview (first 2): {JSON.stringify(data.slice(0,2))}</div>
          </div>
        )}

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
                    <th>Date</th>
                    <th>Action</th>
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
                          <td>{formatQtls(b.totalQtls)}</td>
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
                            <input
                              type="date"
                              style={{ width: 140 }}
                              value={editable[b.buyer]?.date || ''}
                              onChange={e => setEditable(ed => ({ ...ed, [b.buyer]: { ...ed[b.buyer], date: e.target.value } }))}
                              disabled={isLocked}
                              onBlur={async (e) => {
                                // convert to DB format (dd/mm/yyyy) when saving single-field onBlur
                                const dbVal = toDbDate(e.target.value);
                                await updateDoc(doc(db, 'buyers', b.buyer), { date: dbVal });
                              }}
                            />
                          </td>
                          <td>
                            <button
                              className={isLocked ? 'edit-btn' : 'save-edit-btn'}
                              onClick={async () => {
                                if (!isLocked) {
                                  // Save: capture current values and persist, then lock the row
                                  const current = editable[b.buyer] || {};
                                  const payload = {
                                    receivedAmount: current.receivedAmount || '',
                                    paymentMode: current.paymentMode || '',
                                    date: toDbDate(current.date || '')
                                  };
                                  // mark locked immediately in UI so button becomes 'Edit'
                                  setEditable(ed => ({ ...ed, [b.buyer]: { ...ed[b.buyer], locked: true } }));
                                  await updateDoc(doc(db, 'buyers', b.buyer), payload);
                                } else {
                                  // Edit: unlock the row for editing
                                  setEditable(ed => ({ ...ed, [b.buyer]: { ...ed[b.buyer], locked: false } }));
                                }
                              }}
                            >
                              {isLocked ? 'Edit' : 'Save'}
                            </button>
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
