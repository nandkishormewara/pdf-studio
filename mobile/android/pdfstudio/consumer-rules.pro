# PdfBox-Android loads some classes reflectively.
-keep class com.tom_roush.pdfbox.** { *; }
-dontwarn com.gemalto.jp2.**
-dontwarn com.tom_roush.pdfbox.filter.JPXFilter
