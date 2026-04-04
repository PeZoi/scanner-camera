import { Link } from 'react-router-dom'
import '../App.css'

export default function HomePage() {
  return (
    <>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link className="scanner-entry" to="/scanner">
            Scanner html5-qrcode
          </Link>
          <Link className="scanner-entry" to="/scanner-zxing">
            Scanner ZXing (nhanh)
          </Link>
          <Link className="scanner-entry" to="/scanner-scanbot">
            Scanner Scanbot SDK (barcode)
          </Link>
          <Link className="scanner-entry" to="/scanner-pybarcode">
            Scanner Python (OpenCV + pyzbar + WS)
          </Link>
        </div>
        
    </>
  )
}
