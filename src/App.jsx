import React, { useState, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';
import './App.css';
import { db, auth } from './firebase';
import {
  collection,
  getDocs,
  setDoc,
  doc,
  updateDoc,
  onSnapshot,
  deleteDoc,
} from "firebase/firestore";
import { getApp } from 'firebase/app';
import { signInAnonymously } from 'firebase/auth';

function App() {
  const apiUrl = import.meta.env.VITE_API_URL || '';
  // Helper: format a Date using LOCAL timezone as YYYY-MM-DD (avoids UTC off-by-one)
  const formatLocalYMD = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  // Helper: normalize various date inputs into YYYY-MM-DD for <input type="date">
  const toDateInputValue = (v) => {
    if (!v) return '';
    // Firestore Timestamp with toDate()
    if (v && typeof v === 'object' && typeof v.toDate === 'function') {
      const d = v.toDate();
      return isNaN(d) ? '' : formatLocalYMD(d);
    }
    // Firestore Timestamp-like with seconds
    if (v && typeof v === 'object' && 'seconds' in v) {
      const d = new Date(v.seconds * 1000);
      return isNaN(d) ? '' : formatLocalYMD(d);
    }
    // Native Date
    if (v instanceof Date) {
      return formatLocalYMD(v);
    }
    // String handling (try Y-M-D first, then D/M/Y or D-M-Y)
    if (typeof v === 'string') {
      const s = v.trim();
      // Already YYYY-MM-DD or YYYY/MM/DD
      const isoYMD = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
      if (isoYMD) {
        const [_, yy, mm, dd] = isoYMD;
        const d = new Date(Number(yy), Number(mm) - 1, Number(dd));
        return isNaN(d) ? '' : formatLocalYMD(d);
      }
      // Day-first common formats (India default): D/M/Y or D-M-Y
      const dmy = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
      if (dmy) {
        let [_, dd, mm, yy] = dmy;
        if (yy.length === 2) yy = String(2000 + Number(yy));
        const d = new Date(Number(yy), Number(mm) - 1, Number(dd));
        return isNaN(d) ? '' : formatLocalYMD(d);
      }
      // Fallback parse; still render as local YMD if valid
      const d = new Date(s);
      return isNaN(d) ? '' : formatLocalYMD(d);
    }
    return '';
  };
  // Helper: format a Date using LOCAL timezone as DD/MM/YYYY (for display)
  const formatLocalDMY = (d) => {
    const dd = String(d.getDate()).padStart(2, '0');
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const y = d.getFullYear();
    return `${dd}/${m}/${y}`;
  };

  // Display helper: any -> DD/MM/YYYY
  const toDisplayDDMMYYYY = (v) => {
    const ymd = toDateInputValue(v);
    if (!ymd) return '';
    const [y, m, d] = ymd.split('-');
    return `${d}/${m}/${y}`;
  };

  // Parse DD/MM/YYYY -> YYYY-MM-DD (or '' if invalid)
  const parseDDMMYYYY = (s) => {
    if (!s) return '';
    const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return '';
    let [, dd, mm, yy] = m;
    if (yy.length === 2) yy = String(2000 + Number(yy));
    const d = new Date(Number(yy), Number(mm) - 1, Number(dd));
    if (isNaN(d)) return '';
    return formatLocalYMD(d);
  };
  // Small helper to normalize row keys for robust header matching
  const normalizeRow = (row) => {
    const map = {};
    Object.keys(row || {}).forEach((k) => {
      if (!k) return;
      map[k.toString().trim().toUpperCase()] = row[k];
    });
    return map;
  };

  const getVal = (rowMap, candidates = []) => {
    for (const key of candidates) {
      const v = rowMap[key.toUpperCase()];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return '';
  };

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
      'Chq/RTGS/Cash': editable[b.buyer]?.paymentMode || '',
      'Date': (editable[b.buyer] && editable[b.buyer].paymentDateText !== undefined && editable[b.buyer].paymentDateText !== '')
        ? editable[b.buyer].paymentDateText
        : toDisplayDDMMYYYY(editable[b.buyer]?.paymentDate || b.paymentDate || '')
    }));
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Buyers');
    XLSX.writeFile(wb, 'buyers_summary.xlsx');
  };
  const [buyers, setBuyers] = useState([]);
  const [error, setError] = useState('');
  const [buyerFilter, setBuyerFilter] = useState('');
  const [placeFilter, setPlaceFilter] = useState('');
  const [editable, setEditable] = useState({}); // {buyer: {receivedAmount, paymentMode, paymentDate, paymentDateText, locked}}
  // Backend fallback loader
  const loadFromBackend = useCallback(async () => {
    if (!apiUrl) return;
    try {
      const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/buyers`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.json();
      if (Array.isArray(arr)) {
        const editObj = {};
        arr.forEach(d => {
          if (!d?.buyer) return;
          editObj[d.buyer] = {
            receivedAmount: d.receivedAmount || '',
            paymentMode: d.paymentMode || '',
            // prefer explicit saved paymentDate, otherwise fallback to createdAt
            paymentDate: toDisplayDDMMYYYY(d.paymentDate || d.payment_date || d.createdAt || ''),
            paymentDateText: '',
            locked: false
          };
        });
        setBuyers(arr);
        setEditable(editObj);
        // Don't override an existing Firestore error with backend success silently.
        // Clear only if no error was set.
        setError(prev => prev ? prev : '');
      }
    } catch (e) {
      console.error('Backend fetch error:', e);
      // Only set backend error if we don't already have a Firestore error message
      setError(prev => prev || 'Could not load data from backend API.');
    }
  }, [apiUrl]);
  // Load buyers from Firestore on mount and on change
  useEffect(() => {
    let unsub = () => {};
    const startListener = () => onSnapshot(
      collection(db, 'buyers'),
      (snapshot) => {
        const arr = [];
        const editObj = {};
        snapshot.forEach(docSnap => {
          const d = docSnap.data() || {};
          // Normalize possible field names from existing Firestore data
          const buyer = (d.buyer || d.name || d.buyerName || '').toString().trim();
          if (!buyer) return; // skip docs without a buyer identifier
          const place = (d.place || d.location || d.city || '').toString();
          const totalQtls = Number(
            d.totalQtls ?? d.qtls ?? d.total ?? d.total_quintals ?? 0
          ) || 0;
          const commission = Number(
            d.commission ?? d.totalCommission ?? d.comm ?? 0
          ) || 0;
          const receivedAmount = d.receivedAmount || '';
          const paymentMode = d.paymentMode || '';
          // Prefer explicit payment date fields; support Firestore Timestamp or strings
          const paymentDate = toDateInputValue(
            d.paymentDate || d.payment_date || d.date || d.billDate || d.invoiceDate || d.bill_date || d.paidOn || d.paid_date || d.createdAt || ''
          );

          const normalized = { buyer, place, totalQtls, commission, receivedAmount, paymentMode, paymentDate };
          arr.push(normalized);
          editObj[buyer] = {
            receivedAmount: receivedAmount,
            paymentMode: paymentMode,
            paymentDate: toDisplayDDMMYYYY(paymentDate),
            paymentDateText: '',
            locked: false
          };
        });
        setBuyers(arr);
        setEditable(editObj);
        setError('');
        // If Firestore has no data, try backend fallback once
        if (arr.length === 0 && apiUrl) {
          loadFromBackend();
        }
      },
      (err) => {
        console.error('Firestore onSnapshot error:', err);
        const code = err?.code || 'unknown';
        setError(`Could not load data from Firestore (${code}). Check rules/connection.`);
        // Try backend as fallback on error
        if (apiUrl) loadFromBackend();
      }
    );

    (async () => {
      try {
        // Ensure we are signed in if rules require auth
        if (!auth.currentUser) {
          await signInAnonymously(auth);
        }
      } catch (e) {
        console.error('Firebase anonymous auth failed:', e);
        setError('Firebase anonymous auth failed. Enable it in Firebase Console > Authentication > Sign-in method.');
      } finally {
        unsub = startListener();
      }
    })();

    return () => {
      try { unsub && unsub(); } catch { /* ignore */ }
    };
  }, [apiUrl, loadFromBackend]);


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
        // We don't display raw rows/headers in UI, so we skip storing them
        processBuyers(jsonData);
        setError('');
      } catch {
        setError('Invalid Excel file or format.');
      }
    };
    reader.readAsBinaryString(file);
  };

  // Save imported buyers to Firestore (overwrites existing)
  const processBuyers = async (rows) => {
    const buyersMap = {};
    rows.forEach(raw => {
      const row = normalizeRow(raw);
      const buyer = getVal(row, ['BUYER NAME', 'BUYER', 'BUYER NAMER']).toString().trim();
      const qtls = parseFloat(getVal(row, ['QTLS', 'QTL', 'QUINTALS', 'qtls', 'Qtls']) || 0);
      const amount = parseFloat(getVal(row, ['AMOUNT', 'TOTAL AMOUNT', 'Amount']) || 0);
      const miller = (getVal(row, ['MILLER NAME', 'MILLER', 'SELLER']) || '').toString().toLowerCase();
      const place = (getVal(row, ['PLACE', 'LOCATION', 'CITY']) || '').toString().trim();
      // Optional: read a date column if present
  const rawDate = getVal(row, ['DATE', 'BILL DATE', 'INVOICE DATE', 'Date', 'date']);
  const paymentDate = toDateInputValue(rawDate);
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
      // Set/overwrite a per-buyer paymentDate if provided in the sheet
      if (paymentDate) buyersMap[buyer].paymentDate = paymentDate;
    });
    const buyersArray = Object.values(buyersMap);
    // Save to Firestore
    for (const b of buyersArray) {
      await setDoc(doc(db, 'buyers', b.buyer), b, { merge: true });
    }
    // Also upsert to backend if configured
    if (apiUrl && buyersArray.length) {
      try {
        await fetch(`${apiUrl.replace(/\/$/, '')}/api/buyers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buyersArray)
        });
      } catch (e) {
        console.warn('Backend bulk upsert failed:', e);
      }
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
      <div className="footer-note" style={{ marginBottom: 8 }}>
        <small>Connected Firebase project: {(() => {
          try { return getApp().options.projectId || 'unknown'; } catch { return 'unknown'; }
        })()}</small>
      </div>
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
      {/* Content */}
      <div style={{ marginTop: 20 }}>
        {buyers.length === 0 ? (
          <div className="empty-state">
            <p>No buyers found yet. Upload an Excel file to populate data.</p>
          </div>
        ) : (
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
                                const val = e.target.value;
                                await updateDoc(doc(db, 'buyers', b.buyer), { receivedAmount: val });
                                if (apiUrl) {
                                  try {
                                    await fetch(`${apiUrl.replace(/\/$/, '')}/api/buyers/${encodeURIComponent(b.buyer)}`, {
                                      method: 'PATCH',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ receivedAmount: val })
                                    });
                                  } catch (e) {
                                    console.warn('Backend patch failed:', e);
                                  }
                                }
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
                                const val = e.target.value;
                                await updateDoc(doc(db, 'buyers', b.buyer), { paymentMode: val });
                                if (apiUrl) {
                                  try {
                                    await fetch(`${apiUrl.replace(/\/$/, '')}/api/buyers/${encodeURIComponent(b.buyer)}`, {
                                      method: 'PATCH',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ paymentMode: val })
                                    });
                                  } catch (e) {
                                    console.warn('Backend patch failed:', e);
                                  }
                                }
                              }}
                            />
                          </td>
                          <td>
                            {(() => {
                              // Determine current YYYY-MM-DD value for the native date input
                              const currentYMD = (() => {
                                const text = editable[b.buyer]?.paymentDateText;
                                if (text) return parseDDMMYYYY(text);
                                const display = editable[b.buyer]?.paymentDate; // DD/MM/YYYY
                                if (display) return parseDDMMYYYY(display);
                                return toDateInputValue(b.paymentDate || '');
                              })();
                              return (
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                  <input
                                    type="date"
                                    style={{ width: 160 }}
                                    value={currentYMD}
                                    onChange={e => {
                                      const ymd = e.target.value;
                                      setEditable(ed => ({
                                        ...ed,
                                        [b.buyer]: {
                                          ...ed[b.buyer],
                                          paymentDate: toDisplayDDMMYYYY(ymd),
                                          paymentDateText: ''
                                        }
                                      }));
                                    }}
                                    disabled={isLocked}
                                    onBlur={async (e) => {
                                      const ymd = e.target.value;
                                      await updateDoc(doc(db, 'buyers', b.buyer), { paymentDate: ymd });
                                      if (apiUrl) {
                                        try {
                                          await fetch(`${apiUrl.replace(/\/$/, '')}/api/buyers/${encodeURIComponent(b.buyer)}`, {
                                            method: 'PATCH',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ paymentDate: ymd })
                                          });
                                        } catch (e) {
                                          console.warn('Backend patch failed:', e);
                                        }
                                      }
                                    }}
                                  />
                                  <small style={{ color: '#718096', marginTop: 4 }}>
                                    {currentYMD ? toDisplayDDMMYYYY(currentYMD) : ''}
                                  </small>
                                </div>
                              );
                            })()}
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
                                    paymentMode: editable[b.buyer]?.paymentMode || '',
                                    // Save current date from editable (already DD/MM), convert to YMD
                                    paymentDate: parseDDMMYYYY(editable[b.buyer]?.paymentDate || '')
                                  });
                                  if (apiUrl) {
                                    try {
                                      await fetch(`${apiUrl.replace(/\/$/, '')}/api/buyers/${encodeURIComponent(b.buyer)}`, {
                                        method: 'PATCH',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                          receivedAmount: editable[b.buyer]?.receivedAmount || '',
                                          paymentMode: editable[b.buyer]?.paymentMode || '',
                                          paymentDate: parseDDMMYYYY(editable[b.buyer]?.paymentDate || '')
                                        })
                                      });
                                    } catch (e) {
                                      console.warn('Backend patch failed:', e);
                                    }
                                  }
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
          <small>Columns expected: buyer name, qtls, amount, seller, optional: date</small>
        </div>
      </div>
    </div>
  );
}

export default App;
